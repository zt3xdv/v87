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
        this.canvas.style.maxHeight = '100%';
        this.canvas.style.width = 'auto';
        this.canvas.style.height = 'auto';
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.margin = '0 auto';
        this.canvas.style.cursor = 'none';
        this.canvas.tabIndex = 1;
        this.container.style.overflow = 'hidden';
        this.container.style.display = 'flex';
        this.container.style.alignItems = 'center';
        this.container.style.justifyContent = 'center';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        
        this.cursorX = 0;
        this.cursorY = 0;
        this.cursorVisible = true;
        this.touchState = { active: false, lastX: 0, lastY: 0, button: 0 };
        
        this.canvas.addEventListener('mousedown', (e) => this.handleMouse(e, 1));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouse(e, 0));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouse(e, -1));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('keydown', (e) => this.handleKey(e, true));
        this.canvas.addEventListener('keyup', (e) => this.handleKey(e, false));
        
        this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
        this.canvas.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });
        
        window.addEventListener('resize', () => this.fitToContainer());
        
        this.resize(800, 600);
    }
    
    fitToContainer() {
        if (!this.canvas || !this.container) return;
        
        const containerRect = this.container.getBoundingClientRect();
        const aspectRatio = this.width / this.height;
        
        let displayWidth = containerRect.width;
        let displayHeight = containerRect.height;
        
        if (displayWidth / displayHeight > aspectRatio) {
            displayWidth = displayHeight * aspectRatio;
        } else {
            displayHeight = displayWidth / aspectRatio;
        }
        
        this.canvas.style.width = `${Math.floor(displayWidth)}px`;
        this.canvas.style.height = `${Math.floor(displayHeight)}px`;
        this.scale = this.width / displayWidth;
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
        this.fitToContainer();
    }
    
    connect(serverId, token) {
        if (this.socket) {
            this.disconnect();
        }
        
        if (!serverId) {
            this.showStatus('Error: No server ID');
            this.onError('No server ID provided');
            return;
        }
        
        this.state = 'connecting';
        this.showStatus('Connecting to VNC...');
        
        console.log('VNC connecting to server:', serverId);
        
        this.socket = io('/vnc', {
            auth: { token },
            query: { serverId: serverId },
            transports: ['websocket']
        });
        
        this.socket.on('connect', () => {
            this.showStatus('Waiting for VNC handshake...');
        });
        
        this.socket.on('vnc-connected', () => {
            console.log('VNC: received vnc-connected event');
            this.state = 'handshake';
        });
        
        this.socket.on('vnc-data', (data) => {
            console.log('VNC: received data, length:', data.length, 'state:', this.state);
            const bytes = Array.isArray(data) ? new Uint8Array(data) : new Uint8Array(data);
            this.handleData(bytes);
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
        if (this.socket && (this.connected || this.state === 'handshake' || this.state === 'security' || this.state === 'security-result' || this.state === 'init')) {
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
        
        console.log('VNC: server version:', this.rfbVersion);
        
        const response = new Uint8Array([0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a]); // "RFB 003.008\n"
        this.send(response);
        this.state = 'security';
        
        console.log('VNC: sent client version, state:', this.state);
        
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
        this.drawCursor();
        
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
        
        this.cursorX = x;
        this.cursorY = y;
        
        if (buttonMask === -1) {
            buttonMask = (e.buttons & 1) | ((e.buttons & 2) << 1) | ((e.buttons & 4) >> 1);
        }
        
        this.sendPointer(x, y, buttonMask);
    }
    
    handleTouchStart(e) {
        if (!this.connected) return;
        e.preventDefault();
        
        const touch = e.touches[0];
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.width / rect.width;
        const scaleY = this.height / rect.height;
        
        const x = Math.floor((touch.clientX - rect.left) * scaleX);
        const y = Math.floor((touch.clientY - rect.top) * scaleY);
        
        this.cursorX = x;
        this.cursorY = y;
        
        if (e.touches.length === 2) {
            this.touchState = { active: true, lastX: x, lastY: y, button: 4 };
            this.sendPointer(x, y, 4);
        } else {
            this.touchState = { active: true, lastX: x, lastY: y, button: 1, startTime: Date.now(), startX: x, startY: y };
            this.sendPointer(x, y, 1);
        }
        
        this.drawCursor();
    }
    
    handleTouchMove(e) {
        if (!this.connected || !this.touchState.active) return;
        e.preventDefault();
        
        const touch = e.touches[0];
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.width / rect.width;
        const scaleY = this.height / rect.height;
        
        const x = Math.floor((touch.clientX - rect.left) * scaleX);
        const y = Math.floor((touch.clientY - rect.top) * scaleY);
        
        this.cursorX = x;
        this.cursorY = y;
        this.touchState.lastX = x;
        this.touchState.lastY = y;
        
        this.sendPointer(x, y, this.touchState.button);
        this.drawCursor();
    }
    
    handleTouchEnd(e) {
        if (!this.connected) return;
        e.preventDefault();
        
        if (this.touchState.active) {
            this.sendPointer(this.touchState.lastX, this.touchState.lastY, 0);
            this.touchState.active = false;
        }
        
        this.drawCursor();
    }
    
    sendPointer(x, y, buttonMask) {
        const msg = new Uint8Array(6);
        msg[0] = 5;
        msg[1] = buttonMask;
        msg[2] = (x >> 8) & 0xff;
        msg[3] = x & 0xff;
        msg[4] = (y >> 8) & 0xff;
        msg[5] = y & 0xff;
        this.send(msg);
    }
    
    drawCursor() {
        if (!this.cursorVisible || !this.connected) return;
        
        this.ctx.putImageData(this.frameBuffer, 0, 0);
        
        const x = this.cursorX;
        const y = this.cursorY;
        
        this.ctx.fillStyle = '#fff';
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 1;
        
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
        this.ctx.lineTo(x, y + 16);
        this.ctx.lineTo(x + 4, y + 12);
        this.ctx.lineTo(x + 7, y + 18);
        this.ctx.lineTo(x + 9, y + 17);
        this.ctx.lineTo(x + 6, y + 11);
        this.ctx.lineTo(x + 11, y + 11);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();
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
