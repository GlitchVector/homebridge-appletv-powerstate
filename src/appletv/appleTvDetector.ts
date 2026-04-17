import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";
import type { Logging } from "homebridge";

export interface AppleTvStateChange {
  isPoweredOn: boolean;
}

interface DaemonEvent {
  state?: "on" | "off" | "unknown";
  reason?: string;
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled location: dist/appletv/appleTvDetector.js
// Daemon source:     python/atv_power_daemon.py (sibling of dist/)
const DAEMON_PATH = path.resolve(__dirname, "..", "..", "python", "atv_power_daemon.py");

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class AppleTvDetector extends EventEmitter {
  private daemon: ChildProcess | null = null;
  private readlineIface: ReadlineInterface | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncedState: boolean | null = null;
  private pythonMissing = false;
  private stopped = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private haveInitialState = false;
  private lastLoggedError: string | null = null;

  constructor(
    private readonly ip: string,
    private readonly credentials: string | undefined,
    private readonly debounceDuration: number,
    private readonly log: Logging,
  ) {
    super();
  }

  start(): void {
    this.log.info(
      `Starting Apple TV power state detection for ${this.ip} (push-based via pyatv daemon, debounce: ${this.debounceDuration / 1000}s)`,
    );
    this.stopped = false;
    this.spawnDaemon();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.teardownDaemon();
  }

  private teardownDaemon(): void {
    if (this.readlineIface) {
      this.readlineIface.close();
      this.readlineIface = null;
    }
    if (this.daemon) {
      this.daemon.removeAllListeners();
      this.daemon.kill();
      this.daemon = null;
    }
  }

  private spawnDaemon(): void {
    if (this.pythonMissing || this.stopped || this.daemon) return;

    const args: string[] = ["-u", DAEMON_PATH, "--ip", this.ip];
    if (this.credentials) {
      args.push("--companion-credentials", this.credentials);
    }

    this.log.debug(`Spawning pyatv daemon: python3 ${args.join(" ")}`);

    let proc: ChildProcess;
    try {
      proc = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.log.error(`Failed to spawn pyatv daemon: ${String(err)}`);
      this.scheduleRespawn();
      return;
    }

    this.daemon = proc;

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        this.log.error(
          "python3 not found -- install Python 3 and pyatv in the homebridge environment",
        );
        this.pythonMissing = true;
        return;
      }
      this.log.error(`pyatv daemon spawn error: ${err.message}`);
    });

    if (proc.stdout) {
      this.readlineIface = createInterface({ input: proc.stdout });
      this.readlineIface.on("line", (line) => this.handleLine(line));
    }

    if (proc.stderr) {
      proc.stderr.on("data", (buf: Buffer) => {
        const text = buf.toString().trim();
        if (text) this.log.debug(`pyatv daemon stderr: ${text}`);
      });
    }

    proc.on("exit", (code, signal) => {
      if (!this.stopped) {
        this.log.warn(
          `pyatv daemon for ${this.ip} exited (code=${code} signal=${signal}); will respawn`,
        );
      }
      if (this.readlineIface) {
        this.readlineIface.close();
        this.readlineIface = null;
      }
      this.daemon = null;
      this.scheduleRespawn();
    });
  }

  private scheduleRespawn(): void {
    if (this.stopped || this.pythonMissing || this.respawnTimer) return;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.spawnDaemon();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let event: DaemonEvent;
    try {
      event = JSON.parse(line) as DaemonEvent;
    } catch {
      this.log.debug(`pyatv daemon: unparseable line: ${line}`);
      return;
    }

    if (event.error) {
      const msg = event.error;
      if (this.lastLoggedError !== msg) {
        this.log.warn(`Apple TV ${this.ip} ${event.reason ?? "error"}: ${msg}`);
        this.lastLoggedError = msg;
      }
      return;
    }

    if (event.state === "on" || event.state === "off") {
      // any valid event means the daemon+connection are healthy → reset backoff
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastLoggedError = null;

      const isPoweredOn = event.state === "on";
      if (!this.haveInitialState) {
        this.haveInitialState = true;
        this.log.info(
          `Apple TV ${this.ip} initial power state: ${isPoweredOn ? "On" : "Off"} (${event.reason ?? "unknown"})`,
        );
      }
      this.applyDebounce(isPoweredOn);
    }
  }

  private applyDebounce(newState: boolean): void {
    if (this.debouncedState === null) {
      this.debouncedState = newState;
      this.emit("stateChange", { isPoweredOn: newState } satisfies AppleTvStateChange);
      return;
    }

    if (newState === this.debouncedState) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debouncedState = newState;
      this.log.debug(
        `Apple TV ${this.ip} debounced state change: ${newState ? "On" : "Off"}`,
      );
      this.emit("stateChange", { isPoweredOn: newState } satisfies AppleTvStateChange);
    }, this.debounceDuration);
  }
}
