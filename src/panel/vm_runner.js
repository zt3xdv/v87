import fs from "node:fs";
import url from "node:url";
import path from "node:path";
import net from "node:net";
import { V86 } from "../main.js";
import { NodeNetworkAdapter } from "../network_adapter.js";
import { handle9p, set9pRoot } from "../9p_handler.js";
import { LOG_NONE, LOG_ALL, LOG_BIOS, LOG_VIRTIO } from "../const.js";

const TERM_YELLOW_BOLD = "\x1b[1;33m";
const TERM_RED_BOLD = "\x1b[1;31m";
const TERM_RESET = "\x1b[0m";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..", "..");

export class VMInstance {
    constructor(options = {}) {
        this.memorySize = options.memorySize || 256;
        this.cwd = options.cwd || process.cwd();
        this.onOutput = options.onOutput || (() => {});
        this.onStats = options.onStats || (() => {});
        this.onError = options.onError || (() => {});
        this.onClose = options.onClose || (() => {});
        
        this.emulator = null;
        this.netAdapter = null;
        this.statsInterval = null;
        this.lastCycleCount = 0;
        this.lastTime = Date.now();
        this.running = false;
    }
    
    async start() {
        this.onOutput(`${TERM_YELLOW_BOLD}[v87 Daemon] Starting up...${TERM_RESET}\n`);
        
        const wasmPath = path.join(workspaceRoot, "vm/build/v86.wasm");
        const biosPath = path.join(workspaceRoot, "vm/bios/seabios.bin");
        const vgaBiosPath = path.join(workspaceRoot, "vm/bios/vgabios.bin");
        const bzimagePath = path.join(workspaceRoot, "vm/kernel/linux.bin");
        
        const rootPath = path.join(this.cwd, "root");
        const permsPath = path.join(this.cwd, "permissions.json");
        set9pRoot(rootPath, permsPath);
        
        const origCwd = process.cwd();
        try {
            process.chdir(this.cwd);
        } catch(e) {}
        
        this.emulator = new V86({
            bios: { url: biosPath },
            vga_bios: { url: vgaBiosPath },
            bzimage: { url: bzimagePath },
            filesystem: {
                handle9p: handle9p
            },
            log_level: LOG_NONE,
            memory_size: this.memorySize * 1024 * 1024,
            wasm_path: wasmPath,
            autostart: true,
            cmdline: [
                "rw",
                "init=/init",
                "console=ttyS0",
                "rootfstype=9p",
                "rootflags=trans=virtio,version=9p2000.L,cache=loose",
                "root=host9p"
            ].join(" "),
            disable_mouse: true,
            disable_keyboard: false
        });
        
        try {
            process.chdir(origCwd);
        } catch(e) {}
        
        this.netAdapter = new NodeNetworkAdapter(this.emulator.bus);
        
        this.emulator.add_listener("serial0-output-byte", (byte) => {
            const chr = String.fromCharCode(byte);
            this.onOutput(chr);
        });
        
        this.running = true;
        this._startStats();
        
        return this;
    }
    
    _getVMMemoryUsage() {
        if (!this.emulator || !this.emulator.v86 || !this.emulator.v86.cpu) {
            return 0;
        }
        
        try {
            const cpu = this.emulator.v86.cpu;
            let totalBytes = 0;
            
            if (cpu.wasm_memory && cpu.wasm_memory.buffer) {
                totalBytes += cpu.wasm_memory.buffer.byteLength;
            }
            
            if (cpu.mem8 && cpu.mem8.buffer) {
                totalBytes += cpu.mem8.buffer.byteLength;
            }
            
            return Math.round(totalBytes / 1024 / 1024);
        } catch(e) {
            return this.memorySize;
        }
    }
    
    _startStats() {
        this.statsInterval = setInterval(() => {
            if (!this.running) return;
            
            const ram = this._getVMMemoryUsage();
            
            let ips = 0;
            let cpuPercent = 0;
            try {
                if (this.emulator.v86 && this.emulator.v86.cpu && this.emulator.v86.cpu.wm) {
                    const cycles = this.emulator.v86.cpu.wm.exports["profiler_stat_get"](92);
                    const now = Date.now();
                    const elapsed = (now - this.lastTime) / 1000;
                    
                    if (elapsed > 0 && this.lastCycleCount > 0) {
                        ips = Math.round((cycles - this.lastCycleCount) / elapsed);
                        cpuPercent = Math.min(100, Math.round(ips / 1000000));
                    }
                    
                    this.lastCycleCount = cycles;
                    this.lastTime = now;
                }
            } catch(e) {}
            
            this.onStats({
                type: 'stats',
                ram,
                ips,
                cpu: cpuPercent,
                netRx: this.netAdapter ? this.netAdapter.stats.rx : 0,
                netTx: this.netAdapter ? this.netAdapter.stats.tx : 0
            });
        }, 1000);
    }
    
    write(data) {
        if (this.emulator && this.running) {
            this.emulator.serial0_send(data);
        }
    }
    
    stop() {
        this.running = false;
        
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        
        if (this.emulator) {
            try {
                this.emulator.destroy();
            } catch(e) {}
            this.emulator = null;
        }
        
        this.onClose(0);
    }
    
    destroy() {
        this.stop();
    }
}

if (process.argv[1] && process.argv[1].includes('vm_runner.js')) {
    const args = process.argv.slice(2);
    const memorySize = parseInt(args[0]) || 256;
    
    console.log(`${TERM_YELLOW_BOLD}[v87 Daemon] Starting up...${TERM_RESET}`);
    
    const vm = new VMInstance({
        memorySize,
        onOutput: (chr) => process.stdout.write(chr),
        onStats: (stats) => {
            if (process.send) {
                process.send(stats);
            }
        },
        onError: (err) => {
            console.error(`${TERM_RED_BOLD}[v87 Daemon] Error: ${err.message}${TERM_RESET}`);
        }
    });
    
    vm.start().catch(err => {
        console.error(`${TERM_RED_BOLD}[v87 Daemon] Failed to start: ${err.message}${TERM_RESET}`);
        process.exit(1);
    });
    
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    
    process.stdin.on("data", function(c) {
        if(c === "\u0004") {
            vm.destroy();
            process.exit();
        } else {
            vm.write(c);
        }
    });
    
    process.on('uncaughtException', (err) => {
        console.error(`${TERM_RED_BOLD}[v87 Daemon] Error: ${err.message}${TERM_RESET}`);
        process.exit(1);
    });
}
