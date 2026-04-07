import { EventEmitter } from "events";
import { execFile, type ChildProcess } from "child_process";
import type { Logging } from "homebridge";

export interface AppleTvStateChange {
  isPoweredOn: boolean;
}

export class AppleTvDetector extends EventEmitter {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentProcess: ChildProcess | null = null;
  private debouncedState: boolean | null = null;
  private isFirstPoll = true;
  private pyatvMissing = false;

  constructor(
    private readonly ip: string,
    private readonly credentials: string | undefined,
    private readonly pollingInterval: number,
    private readonly debounceDuration: number,
    private readonly log: Logging,
  ) {
    super();
  }

  start(): void {
    this.log.info(`Starting Apple TV power state detection for ${this.ip} (poll: ${this.pollingInterval / 1000}s, debounce: ${this.debounceDuration / 1000}s)`);
    this.pollPowerState();
    this.pollTimer = setInterval(() => this.pollPowerState(), this.pollingInterval);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  private pollPowerState(): void {
    if (this.pyatvMissing) {
      return;
    }

    // Don't start a new poll if one is still running
    if (this.currentProcess) {
      return;
    }

    const args = ["-s", this.ip];
    if (this.credentials) {
      args.push("--companion-credentials", this.credentials);
    }
    args.push("power_state");

    const timeout = 10_000;

    try {
      this.currentProcess = execFile("atvremote", args, { timeout }, (error, stdout, stderr) => {
        this.currentProcess = null;

        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            this.log.error("atvremote not found -- install pyatv: pip3 install pyatv");
            this.pyatvMissing = true;
            return;
          }
          this.log.warn(`Failed to poll Apple TV power state: ${error.message}`);
          if (stderr?.trim()) {
            this.log.debug(`atvremote stderr: ${stderr.trim()}`);
          }
          // Fail-safe: keep last known state
          return;
        }

        const output = stdout.trim();
        const isPoweredOn = output.includes("PowerState.On");

        if (this.isFirstPoll) {
          this.isFirstPoll = false;
          this.log.info(`Apple TV ${this.ip} initial power state: ${isPoweredOn ? "On" : "Off"} (raw: ${output})`);
        }

        this.applyDebounce(isPoweredOn);
      });
    } catch (err) {
      this.currentProcess = null;
      this.log.error(`Failed to spawn atvremote: ${err}`);
    }
  }

  private applyDebounce(newState: boolean): void {
    // If this is the first state we've seen, emit immediately
    if (this.debouncedState === null) {
      this.debouncedState = newState;
      this.emit("stateChange", { isPoweredOn: newState } satisfies AppleTvStateChange);
      return;
    }

    // If state hasn't changed, clear any pending debounce
    if (newState === this.debouncedState) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      return;
    }

    // State changed -- start/reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debouncedState = newState;
      this.log.debug(`Apple TV ${this.ip} debounced state change: ${newState ? "On" : "Off"}`);
      this.emit("stateChange", { isPoweredOn: newState } satisfies AppleTvStateChange);
    }, this.debounceDuration);
  }
}
