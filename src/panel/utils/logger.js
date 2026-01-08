const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

const symbols = {
    info: `${c.blue}●${c.reset}`,
    success: `${c.green}✓${c.reset}`,
    warn: `${c.yellow}⚠${c.reset}`,
    error: `${c.red}✗${c.reset}`,
    arrow: `${c.cyan}→${c.reset}`
};

function getTimestamp() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(message, type = 'info') {
    console.log(`  ${c.dim}${getTimestamp()}${c.reset}  ${symbols[type] || symbols.info}  ${message}`);
}

function logSuccess(message) { log(message, 'success'); }
function logWarn(message) { log(message, 'warn'); }
function logError(message) { log(message, 'error'); }

export { c, symbols, log, logSuccess, logWarn, logError };
