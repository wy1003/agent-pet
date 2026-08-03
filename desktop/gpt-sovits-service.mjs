import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const LOCAL_BASE_URL = "http://127.0.0.1:9880";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class GptSovitsServiceController {
  constructor(engineRoot, options = {}) {
    this.engineRoot = engineRoot;
    this.spawnProcess = options.spawnProcess || spawn;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.child = null;
    this.logStream = null;
    this.state = "stopped";
    this.lastError = "";
    this.stopRequested = false;
  }

  get paths() {
    const environmentRoot = path.join(this.engineRoot, "env");
    const sourceRoot = path.join(this.engineRoot, "source");
    return {
      marker: path.join(this.engineRoot, "installation.json"),
      python: path.join(environmentRoot, "python.exe"),
      api: path.join(sourceRoot, "api_v2.py"),
      environmentRoot,
      sourceRoot,
      logRoot: path.join(this.engineRoot, "logs"),
      log: path.join(this.engineRoot, "logs", "service.log"),
    };
  }

  async isInstalled() {
    const paths = this.paths;
    return (await exists(paths.marker)) && (await exists(paths.python)) && (await exists(paths.api));
  }

  async installationInfo() {
    try {
      const value = JSON.parse(await readFile(this.paths.marker, "utf8"));
      return {
        device: ["CPU", "CU126", "CU128"].includes(value?.device) ? value.device : "",
        source: ["ModelScope", "HF-Mirror", "HF"].includes(value?.source)
          ? value.source
          : "ModelScope",
        version: String(value?.version || ""),
        installedAt: String(value?.installedAt || ""),
      };
    } catch {
      return { device: "", source: "ModelScope", version: "", installedAt: "" };
    }
  }

  hasManagedProcess() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  async isHealthy() {
    try {
      const response = await this.fetchImpl(`${LOCAL_BASE_URL}/openapi.json`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const schema = await response.json();
      return Boolean(schema?.paths?.["/tts"]);
    } catch {
      return false;
    }
  }

  async status() {
    const installed = await this.isInstalled();
    if (!installed) {
      return { installed: false, state: "not-installed", managed: false, logPath: this.paths.log };
    }

    const installation = await this.installationInfo();
    if (await this.isHealthy()) {
      this.state = "running";
      return {
        installed: true,
        state: "running",
        managed: Boolean(this.child && this.child.exitCode === null),
        pid: this.child?.pid || null,
        logPath: this.paths.log,
        installation,
      };
    }

    if (this.child && this.child.exitCode === null) {
      return {
        installed: true,
        state: "starting",
        managed: true,
        pid: this.child.pid,
        logPath: this.paths.log,
        installation,
      };
    }

    return {
      installed: true,
      state: this.state === "error" ? "error" : "stopped",
      managed: false,
      error: this.lastError,
      logPath: this.paths.log,
      installation,
    };
  }

  async start() {
    if (!(await this.isInstalled())) {
      throw new Error("GPT-SoVITS 尚未安装完成");
    }
    if (await this.isHealthy()) return this.status();
    if (this.child && this.child.exitCode === null) return this.status();

    const paths = this.paths;
    await mkdir(paths.logRoot, { recursive: true });
    this.logStream = createWriteStream(paths.log, { flags: "a", encoding: "utf8" });
    this.logStream.on("error", (error) => {
      this.lastError = `无法写入服务日志：${error.message}`;
    });
    this.logStream.write(`\n[${new Date().toISOString()}] Starting GPT-SoVITS\n`);

    const environmentPath = [
      paths.environmentRoot,
      path.join(paths.environmentRoot, "Scripts"),
      path.join(paths.environmentRoot, "Library", "bin"),
      path.join(paths.environmentRoot, "Library", "usr", "bin"),
      process.env.PATH || "",
    ].join(path.delimiter);
    const childEnvironment = {
      ...process.env,
      MAMBA_ROOT_PREFIX: path.join(this.engineRoot, "mamba-root"),
      PIP_CACHE_DIR: path.join(this.engineRoot, "pip-cache"),
      PIP_CONFIG_FILE: "NUL",
      HF_HOME: path.join(this.engineRoot, "model-cache", "huggingface"),
      MODELSCOPE_CACHE: path.join(this.engineRoot, "model-cache", "modelscope"),
      XDG_CACHE_HOME: path.join(this.engineRoot, "cache"),
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
      CONDA_PREFIX: paths.environmentRoot,
      PATH: environmentPath,
    };

    this.stopRequested = false;
    this.lastError = "";
    this.state = "starting";
    this.child = this.spawnProcess(
      paths.python,
      [paths.api, "-a", "127.0.0.1", "-p", "9880"],
      {
        cwd: paths.sourceRoot,
        env: childEnvironment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.stdout?.pipe(this.logStream, { end: false });
    this.child.stderr?.pipe(this.logStream, { end: false });
    this.child.once("error", (error) => {
      this.state = "error";
      this.lastError = error.message;
      this.logStream?.write(`[${new Date().toISOString()}] Start error: ${error.stack || error}\n`);
    });
    this.child.once("exit", (code, signal) => {
      if (this.stopRequested || code === 0) {
        this.state = "stopped";
      } else {
        this.state = "error";
        this.lastError = `服务进程已退出（代码 ${code ?? "unknown"}${signal ? `，信号 ${signal}` : ""}）`;
      }
      this.logStream?.write(`[${new Date().toISOString()}] Process exited: ${code ?? "unknown"} ${signal || ""}\n`);
      this.logStream?.end();
      this.logStream = null;
      this.child = null;
    });
    return this.status();
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      const healthy = await this.isHealthy();
      return {
        ...(await this.status()),
        external: healthy,
      };
    }

    const child = this.child;
    this.stopRequested = true;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (this.child === child && child.exitCode === null) child.kill("SIGKILL");
    this.state = "stopped";
    return this.status();
  }
}

export { LOCAL_BASE_URL };
