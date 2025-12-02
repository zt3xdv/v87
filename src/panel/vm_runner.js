import fs from "node:fs";
import url from "node:url";
import path from "node:path";
import net from "node:net";
import { V86 } from "../main.js";
import { NodeNetworkAdapter } from "../network_adapter.js";
import { handle9p } from "../9p_handler.js";
import { LOG_NONE, LOG_ALL, LOG_BIOS, LOG_VIRTIO } from "../const.js";

const TERM_YELLOW_BOLD = "\x1b[1;33m";
const TERM_RED_BOLD = "\x1b[1;31m";
const TERM_RESET = "\x1b[0m";

const args = process.argv.slice(2);
const memorySize = parseInt(args[0]) || 256;

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..", "..");

const wasmPath = path.join(workspaceRoot, "vm/build/v86.wasm");

const biosPath = path.join(workspaceRoot, "vm/bios/seabios.bin");
const vgaBiosPath = path.join(workspaceRoot, "vm/bios/vgabios.bin");

const bzimagePath = path.join(workspaceRoot, "vm/kernel/linux.bin");
const initrdPath = path.join(workspaceRoot, "vm/initrd/linux.img");

console.log(`${TERM_YELLOW_BOLD}[v87 Daemon] Starting up...${TERM_RESET}`);

const emulator = new V86({
    bios: { url: biosPath },
    vga_bios: { url: vgaBiosPath },
    
    bzimage: { url: bzimagePath },
    initrd: { url: initrdPath },
    
    filesystem: {
        handle9p: handle9p
    },
    
    log_level: LOG_NONE,
    
    memory_size: memorySize * 1024 * 1024,
    
    wasm_path: wasmPath,
    autostart: true,
    
    cmdline: [
      "root=/dev/ram0",
      "rw",
      "init=/init",
      "console=ttyS0",
      "quiet"
    ].join(" "),
    
    disable_mouse: true,
    disable_keyboard: false
});

const netAdapter = new NodeNetworkAdapter(emulator.bus);

emulator.add_listener("serial0-output-byte", function(byte) {
    const chr = String.fromCharCode(byte);
    process.stdout.write(chr);
});

if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", function(c) {
    if(c === "\u0004") {
        emulator.destroy();
        process.exit();
    } else {
        emulator.serial0_send(c);
    }
});

process.on('uncaughtException', (err) => {
    console.error(`${TERM_RED_BOLD}[v87 Daemon] Error: ${err.message}${TERM_RESET}`);
    process.exit(1);
});

setInterval(() => {
    const ram = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (process.send) {
        process.send({
            type: 'stats',
            ram,
            netRx: netAdapter.stats.rx,
            netTx: netAdapter.stats.tx
        });
    }
}, 1000);
