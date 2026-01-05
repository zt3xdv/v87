class VNCClient {
    constructor(container, options = {}) {
        this.container = container;
        this.canvas = null;
        this.ctx = null;
        this.socket = null;
        this.connected = false;
        this.width = 800;
        this.height = 600;
        this.scale = 1;
        
        this.frameBuffer = null;
        this.state = 'disconnected';
        
        this.onConnect = options.onConnect || (() => {});
        this.onDisconnect = options.onDisconnect || (() => {});
        this.onError = options.onError || (() => {});
        
        this.rfbVersion = '';
        this.serverName = '';
        this.pixelFormat = null;
        this.buffer = new Uint8Array(0);
        
        this.init();
    }
    
    init() {
        this.canvas = document.createElement('canvas');
        this.canvas.style.background = '#000';
        this.canvas.style.display = 'block';
        this.canvas.style.maxWidth = '100%';
        this.canvas.style.margin = '0 auto';
        this.canvas.tabIndex = 1;
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        
        this.canvas.addEventListener('mousedown', (e) => this.handleMouse(e, 1));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouse(e, 0));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouse(e, -1));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('keydown', (e) => this.handleKey(e, true));
        this.canvas.addEventListener('keyup', (e) => this.handleKey(e, false));
        
        this.resize(800, 600);
    }
    
    resize(width, height) {
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
        this.frameBuffer = this.ctx.createImageData(width, height);
        for (let i = 3; i < this.frameBuffer.data.length; i += 4) {
            this.frameBuffer.data[i] = 255;
        }
    }
    
    connect(serverId, token) {
        if (this.socket) {
            this.disconnect();
        }
        
        this.state = 'connecting';
        this.showStatus('Connecting to VNC...');
        
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.socket = io('/vnc', {
            auth: { token },
            query: { serverId },
            transports: ['websocket']
        });
        
        this.socket.on('connect', () => {
            this.showStatus('Waiting for VNC handshake...');
        });
        
        this.socket.on('vnc-connected', () => {
            this.state = 'handshake';
        });
        
        this.socket.on('vnc-data', (data) => {
            this.handleData(new Uint8Array(data));
        });
        
        this.socket.on('vnc-disconnected', () => {
            this.connected = false;
            this.state = 'disconnected';
            this.showStatus('VNC Disconnected');
            this.onDisconnect();
        });
        
        this.socket.on('error', (err) => {
            this.showStatus('Error: ' + err);
            this.onError(err);
        });
        
        this.socket.on('disconnect', () => {
            this.connected = false;
            this.state = 'disconnected';
        });
    }
    
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.connected = false;
        this.state = 'disconnected';
        this.buffer = new Uint8Array(0);
    }
    
    send(data) {
        if (this.socket && this.connected) {
            this.socket.emit('vnc-data', data);
        }
    }
    
    handleData(data) {
        const combined = new Uint8Array(this.buffer.length + data.length);
        combined.set(this.buffer);
        combined.set(data, this.buffer.length);
        this.buffer = combined;
        
        this.processBuffer();
    }
    
    processBuffer() {
        while (this.buffer.length > 0) {
            let consumed = 0;
            
            switch (this.state) {
                case 'handshake':
                    consumed = this.handleProtocolVersion();
                    break;
                case 'security':
                    consumed = this.handleSecurity();
                    break;
                case 'security-result':
                    consumed = this.handleSecurityResult();
                    break;
                case 'init':
                    consumed = this.handleServerInit();
                    break;
                case 'connected':
                    consumed = this.handleMessage();
                    break;
                default:
                    return;
            }
            
            if (consumed === 0) break;
            this.buffer = this.buffer.slice(consumed);
        }
    }
    
    handleProtocolVersion() {
        if (this.buffer.length < 12) return 0;
        
        const version = String.fromCharCode(...this.buffer.slice(0, 12));
        this.rfbVersion = version.trim();
        
        this.send(new TextEncoder().encode('RFB 003.008\n'));
        this.state = 'security';
        
        return 12;
    }
    
    handleSecurity() {
        if (this.buffer.length < 1) return 0;
        
        const numTypes = this.buffer[0];
        if (this.buffer.length < 1 + numTypes) return 0;
        
        const types = this.buffer.slice(1, 1 + numTypes);
        
        if (types.includes(1)) {
            this.send(new Uint8Array([1]));
            this.state = 'security-result';
        } else {
            this.showStatus('No supported security type');
            this.disconnect();
        }
        
        return 1 + numTypes;
    }
    
    handleSecurityResult() {
        if (this.buffer.length < 4) return 0;
        
        const result = (this.buffer[0] << 24) | (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
        
        if (result === 0) {
            this.send(new Uint8Array([1]));
            this.state = 'init';
        } else {
            this.showStatus('Security handshake failed');
            this.disconnect();
        }
        
        return 4;
    }
    
    handleServerInit() {
        if (this.buffer.length < 24) return 0;
        
        const width = (this.buffer[0] << 8) | this.buffer[1];
        const height = (this.buffer[2] << 8) | this.buffer[3];
        
        this.pixelFormat = {
            bitsPerPixel: this.buffer[4],
            depth: this.buffer[5],
            bigEndian: this.buffer[6],
            trueColor: this.buffer[7],
            redMax: (this.buffer[8] << 8) | this.buffer[9],
            greenMax: (this.buffer[10] << 8) | this.buffer[11],
            blueMax: (this.buffer[12] << 8) | this.buffer[13],
            redShift: this.buffer[14],
            greenShift: this.buffer[15],
            blueShift: this.buffer[16]
        };
        
        const nameLen = (this.buffer[20] << 24) | (this.buffer[21] << 16) | (this.buffer[22] << 8) | this.buffer[23];
        if (this.buffer.length < 24 + nameLen) return 0;
        
        this.serverName = String.fromCharCode(...this.buffer.slice(24, 24 + nameLen));
        
        this.resize(width, height);
        this.connected = true;
        this.state = 'connected';
        this.showStatus('');
        this.onConnect();
        
        this.setPixelFormat();
        this.setEncodings();
        this.requestUpdate(false);
        
        return 24 + nameLen;
    }
    
    setPixelFormat() {
        const msg = new Uint8Array(20);
        msg[0] = 0;
        msg[4] = 32;
        msg[5] = 24;
        msg[6] = 0;
        msg[7] = 1;
        msg[8] = 0; msg[9] = 255;
        msg[10] = 0; msg[11] = 255;
        msg[12] = 0; msg[13] = 255;
        msg[14] = 16;
        msg[15] = 8;
        msg[16] = 0;
        this.send(msg);
        
        this.pixelFormat = {
            bitsPerPixel: 32,
            depth: 24,
            bigEndian: false,
            trueColor: true,
            redMax: 255,
            greenMax: 255,
            blueMax: 255,
            redShift: 16,
            greenShift: 8,
            blueShift: 0
        };
    }
    
    setEncodings() {
        const encodings = [0];
        const msg = new Uint8Array(4 + encodings.length * 4);
        msg[0] = 2;
        msg[2] = (encodings.length >> 8) & 0xff;
        msg[3] = encodings.length & 0xff;
        
        for (let i = 0; i < encodings.length; i++) {
            const enc = encodings[i];
            const offset = 4 + i * 4;
            msg[offset] = (enc >> 24) & 0xff;
            msg[offset + 1] = (enc >> 16) & 0xff;
            msg[offset + 2] = (enc >> 8) & 0xff;
            msg[offset + 3] = enc & 0xff;
        }
        
        this.send(msg);
    }
    
    requestUpdate(incremental = true) {
        const msg = new Uint8Array(10);
        msg[0] = 3;
        msg[1] = incremental ? 1 : 0;
        msg[2] = 0; msg[3] = 0;
        msg[4] = 0; msg[5] = 0;
        msg[6] = (this.width >> 8) & 0xff;
        msg[7] = this.width & 0xff;
        msg[8] = (this.height >> 8) & 0xff;
        msg[9] = this.height & 0xff;
        this.send(msg);
    }
    
    handleMessage() {
        if (this.buffer.length < 1) return 0;
        
        const msgType = this.buffer[0];
        
        switch (msgType) {
            case 0:
                return this.handleFramebufferUpdate();
            case 1:
                return this.handleSetColorMap();
            case 2:
                return 1;
            case 3:
                return this.handleServerCutText();
            default:
                return 1;
        }
    }
    
    handleFramebufferUpdate() {
        if (this.buffer.length < 4) return 0;
        
        const numRects = (this.buffer[2] << 8) | this.buffer[3];
        let offset = 4;
        
        for (let i = 0; i < numRects; i++) {
            if (this.buffer.length < offset + 12) return 0;
            
            const x = (this.buffer[offset] << 8) | this.buffer[offset + 1];
            const y = (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
            const w = (this.buffer[offset + 4] << 8) | this.buffer[offset + 5];
            const h = (this.buffer[offset + 6] << 8) | this.buffer[offset + 7];
            const encoding = (this.buffer[offset + 8] << 24) | (this.buffer[offset + 9] << 16) | 
                           (this.buffer[offset + 10] << 8) | this.buffer[offset + 11];
            
            offset += 12;
            
            if (encoding === 0) {
                const pixelBytes = w * h * 4;
                if (this.buffer.length < offset + pixelBytes) return 0;
                
                this.drawRect(x, y, w, h, this.buffer.slice(offset, offset + pixelBytes));
                offset += pixelBytes;
            }
        }
        
        this.ctx.putImageData(this.frameBuffer, 0, 0);
        
        setTimeout(() => this.requestUpdate(true), 33);
        
        return offset;
    }
    
    drawRect(x, y, w, h, pixels) {
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const srcIdx = (py * w + px) * 4;
                const dstIdx = ((y + py) * this.width + (x + px)) * 4;
                
                this.frameBuffer.data[dstIdx] = pixels[srcIdx + 2];
                this.frameBuffer.data[dstIdx + 1] = pixels[srcIdx + 1];
                this.frameBuffer.data[dstIdx + 2] = pixels[srcIdx];
                this.frameBuffer.data[dstIdx + 3] = 255;
            }
        }
    }
    
    handleSetColorMap() {
        if (this.buffer.length < 6) return 0;
        const numColors = (this.buffer[4] << 8) | this.buffer[5];
        return 6 + numColors * 6;
    }
    
    handleServerCutText() {
        if (this.buffer.length < 8) return 0;
        const len = (this.buffer[4] << 24) | (this.buffer[5] << 16) | (this.buffer[6] << 8) | this.buffer[7];
        if (this.buffer.length < 8 + len) return 0;
        return 8 + len;
    }
    
    handleMouse(e, buttonMask) {
        if (!this.connected) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.width / rect.width;
        const scaleY = this.height / rect.height;
        
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        
        if (buttonMask === -1) {
            buttonMask = (e.buttons & 1) | ((e.buttons & 2) << 1) | ((e.buttons & 4) >> 1);
        }
        
        const msg = new Uint8Array(6);
        msg[0] = 5;
        msg[1] = buttonMask;
        msg[2] = (x >> 8) & 0xff;
        msg[3] = x & 0xff;
        msg[4] = (y >> 8) & 0xff;
        msg[5] = y & 0xff;
        this.send(msg);
    }
    
    handleKey(e, down) {
        if (!this.connected) return;
        e.preventDefault();
        
        let key = this.jsKeyToX11(e.key, e.code, e.keyCode);
        if (!key) return;
        
        const msg = new Uint8Array(8);
        msg[0] = 4;
        msg[1] = down ? 1 : 0;
        msg[4] = (key >> 24) & 0xff;
        msg[5] = (key >> 16) & 0xff;
        msg[6] = (key >> 8) & 0xff;
        msg[7] = key & 0xff;
        this.send(msg);
    }
    
    jsKeyToX11(key, code, keyCode) {
        const keyMap = {
            'Backspace': 0xff08, 'Tab': 0xff09, 'Enter': 0xff0d, 'Escape': 0xff1b,
            'Delete': 0xffff, 'Home': 0xff50, 'End': 0xff57, 'PageUp': 0xff55,
            'PageDown': 0xff56, 'ArrowLeft': 0xff51, 'ArrowUp': 0xff52,
            'ArrowRight': 0xff53, 'ArrowDown': 0xff54, 'Insert': 0xff63,
            'F1': 0xffbe, 'F2': 0xffbf, 'F3': 0xffc0, 'F4': 0xffc1, 'F5': 0xffc2,
            'F6': 0xffc3, 'F7': 0xffc4, 'F8': 0xffc5, 'F9': 0xffc6, 'F10': 0xffc7,
            'F11': 0xffc8, 'F12': 0xffc9, 'Shift': 0xffe1, 'Control': 0xffe3,
            'Alt': 0xffe9, 'Meta': 0xffeb, 'CapsLock': 0xffe5, ' ': 0x20
        };
        
        if (keyMap[key]) return keyMap[key];
        if (key.length === 1) return key.charCodeAt(0);
        
        return null;
    }
    
    showStatus(msg) {
        if (msg) {
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.width, this.height);
            this.ctx.fillStyle = '#888';
            this.ctx.font = '16px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(msg, this.width / 2, this.height / 2);
        }
    }
    
    destroy() {
        this.disconnect();
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}
