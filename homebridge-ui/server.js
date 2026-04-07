import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import { execFile, spawn } from "child_process";

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.pairingProcess = null;
    this.pairingResolve = null;

    this.onRequest("/scan", this.handleScan.bind(this));
    this.onRequest("/pair", this.handlePair.bind(this));
    this.onRequest("/pin", this.handlePin.bind(this));
    this.onRequest("/cancel-pair", this.handleCancelPair.bind(this));

    this.ready();
  }

  async handleScan() {
    return new Promise((resolve, reject) => {
      execFile("atvremote", ["scan"], { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT") {
            reject(new Error("atvremote not found. Install pyatv: pip3 install pyatv"));
            return;
          }
          reject(new Error(`Scan failed: ${error.message}`));
          return;
        }

        const devices = this.parseScanOutput(stdout);
        resolve({ devices });
      });
    });
  }

  parseScanOutput(output) {
    const devices = [];
    // Remove the "Scan Results" header and separator line
    const body = output.replace(/^.*?={3,}\n/s, "");
    // Split devices on double blank lines
    const blocks = body.split(/\n\s*\n/).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const device = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Name:")) {
          device.name = trimmed.replace("Name:", "").trim();
        } else if (trimmed.startsWith("Address:")) {
          device.ip = trimmed.replace("Address:", "").trim();
        } else if (trimmed.startsWith("Model/SW:")) {
          device.model = trimmed.replace("Model/SW:", "").trim();
        } else if (trimmed.startsWith("MAC:")) {
          device.mac = trimmed.replace("MAC:", "").trim();
        } else if (trimmed.startsWith("Deep Sleep:")) {
          device.deepSleep = trimmed.replace("Deep Sleep:", "").trim() === "True";
        }
      }

      if (device.name && device.ip) {
        devices.push(device);
      }
    }

    return devices;
  }

  async handlePair(payload) {
    if (this.pairingProcess) {
      throw new Error("A pairing process is already running. Cancel it first.");
    }

    const { ip } = payload;
    if (!ip) {
      throw new Error("IP address is required");
    }

    const args = ["-s", ip, "--protocol", "companion", "pair"];

    return new Promise((resolve, reject) => {
      let outputBuffer = "";

      this.pairingProcess = spawn("atvremote", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        this.cleanupPairing();
        reject(new Error("Pairing timed out after 60 seconds"));
      }, 60000);

      this.pairingProcess.stdout.on("data", (data) => {
        outputBuffer += data.toString();

        // Check if pyatv is asking for the PIN
        if (outputBuffer.includes("Enter PIN")) {
          this.pushEvent("pairing-status", { status: "pin-requested" });
        }
      });

      this.pairingProcess.stderr.on("data", (data) => {
        outputBuffer += data.toString();

        if (outputBuffer.includes("Enter PIN")) {
          this.pushEvent("pairing-status", { status: "pin-requested" });
        }
      });

      this.pairingProcess.on("close", (code) => {
        clearTimeout(timeout);
        const process = this.pairingProcess;
        this.pairingProcess = null;

        if (code === 0) {
          // Extract credentials from output
          const credentials = this.extractCredentials(outputBuffer);
          if (credentials) {
            resolve({ success: true, credentials });
          } else {
            resolve({ success: true, output: outputBuffer });
          }
        } else {
          reject(new Error(`Pairing failed (exit code ${code}): ${outputBuffer}`));
        }
      });

      this.pairingProcess.on("error", (err) => {
        clearTimeout(timeout);
        this.pairingProcess = null;
        reject(new Error(`Failed to start pairing: ${err.message}`));
      });

      // Store resolve so handlePin can complete the promise indirectly
      // Actually, the process close event handles resolution
    });
  }

  extractCredentials(output) {
    // pyatv outputs credentials in various formats, look for common patterns
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Credentials are typically a long hex/base64 string after "Credentials:"
      if (trimmed.startsWith("Credentials:")) {
        return trimmed.replace("Credentials:", "").trim();
      }
      // Some versions use different format
      if (trimmed.includes("credentials:")) {
        const match = trimmed.match(/credentials:\s*(.+)/i);
        if (match) {
          return match[1].trim();
        }
      }
    }
    return null;
  }

  async handlePin(payload) {
    const { pin } = payload;
    if (!pin) {
      throw new Error("PIN is required");
    }

    if (!this.pairingProcess) {
      throw new Error("No active pairing process. Start pairing first.");
    }

    // Write PIN to the pairing process stdin
    this.pairingProcess.stdin.write(pin + "\n");

    return { success: true };
  }

  async handleCancelPair() {
    this.cleanupPairing();
    return { success: true };
  }

  cleanupPairing() {
    if (this.pairingProcess) {
      this.pairingProcess.kill();
      this.pairingProcess = null;
    }
  }
}

(() => new PluginUiServer())();
