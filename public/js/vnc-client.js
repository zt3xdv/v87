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
        
        // Optimizations
        this.qualityLevel = options.quality || 6;
        this.compressionLevel = options.compression || 9;
        this.adaptiveFrameRate = true;
        this.minFrameInterval = 50;  // 20 FPS max
        this.maxFrameInterval = 200; // 5 FPS min
        this.currentFrameInterval = 50;
        this.lastFrameTime = 0;
        this.pendingFrames = 0;
        this.frameRequestPending = false;
        
        // ZRLE state
        this.zrleBuffer = null;
        this.zrlePalette = new Uint32Array(128);
        
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
        this.canvas.style.cursor = 'default';
        this.canvas.tabIndex = 1;
        this.container.style.overflow = 'hidden';
        this.container.style.display = 'flex';
        this.container.style.alignItems = 'center';
        this.container.style.justifyContent = 'center';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
        
        this.cursorX = 0;
        this.cursorY = 0;
        this.cursorVisible = false; // VM cursor is synced via USB tablet
        this.localCursorFallback = false; // Enable if VM cursor not visible
        this.touchState = { active: false, lastX: 0, lastY: 0, button: 0 };
        
        // Throttled mouse move
        this.lastMouseSend = 0;
        this.mouseThrottle = 16; // ~60Hz max
        
        this.canvas.addEventListener('mousedown', (e) => this.handleMouse(e, 1));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouse(e, 0));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
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
        
        this.socket = io('/vnc', {
            auth: { token },
            query: { serverId: serverId },
            transports: ['websocket']
        });
        
        this.socket.on('connect', () => {
            this.showStatus('Waiting for VNC handshake...');
        });
        
        this.socket.on('vnc-connected', () => {
            console.log('VNC: vnc-connected received, waiting for server version');
            this.state = 'handshake';
        });
        
        this.socket.on('vnc-data', (data) => {
            let bytes;
            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                bytes = data;
            } else if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
                bytes = new Uint8Array(data.data);
            } else if (Array.isArray(data)) {
                bytes = new Uint8Array(data);
            } else if (typeof data === 'object' && data !== null) {
                bytes = new Uint8Array(Object.values(data));
            } else {
                console.error('VNC: Unknown data format', typeof data, data);
                return;
            }
            console.log('VNC: received', bytes.length, 'bytes, state:', this.state);
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
            this.socket.emit('vnc-data', Array.from(data));
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
        
        const response = new Uint8Array([0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a]);
        this.send(response);
        this.state = 'security';
        console.log('VNC: sent client version, waiting for security types');
        
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
            this.send(new Uint8Array([1])); // shared flag
            this.state = 'init';
        } else {
            this.showStatus('Authentication failed');
            this.disconnect();
        }
        
        return 4;
    }
    
    handleServerInit() {
        if (this.buffer.length < 24) return 0;
        
        const w = (this.buffer[0] << 8) | this.buffer[1];
        const h = (this.buffer[2] << 8) | this.buffer[3];
        
        const nameLen = (this.buffer[20] << 24) | (this.buffer[21] << 16) | (this.buffer[22] << 8) | this.buffer[23];
        if (this.buffer.length < 24 + nameLen) return 0;
        
        this.serverName = String.fromCharCode(...this.buffer.slice(24, 24 + nameLen));
        
        this.resize(w, h);
        
        // Set optimized pixel format: 32-bit BGRA
        const setPixelFormat = new Uint8Array(20);
        setPixelFormat[0] = 0;  // SetPixelFormat
        setPixelFormat[4] = 32; // bits-per-pixel
        setPixelFormat[5] = 24; // depth
        setPixelFormat[6] = 0;  // big-endian
        setPixelFormat[7] = 1;  // true-color
        setPixelFormat[8] = 0; setPixelFormat[9] = 255;   // red-max
        setPixelFormat[10] = 0; setPixelFormat[11] = 255; // green-max
        setPixelFormat[12] = 0; setPixelFormat[13] = 255; // blue-max
        setPixelFormat[14] = 16; // red-shift
        setPixelFormat[15] = 8;  // green-shift
        setPixelFormat[16] = 0;  // blue-shift
        this.send(setPixelFormat);
        
        // Request encodings (priority order: most efficient first)
        // Keep it simple: CopyRect + Hextile + Raw
        const encodings = [
            1,     // CopyRect - copies existing screen areas (very efficient)
            5,     // Hextile - good compression, widely supported
            0,     // Raw - fallback
        ];
        
        const setEncodings = new Uint8Array(4 + encodings.length * 4);
        setEncodings[0] = 2; // SetEncodings
        setEncodings[2] = (encodings.length >> 8) & 0xff;
        setEncodings[3] = encodings.length & 0xff;
        
        for (let i = 0; i < encodings.length; i++) {
            const enc = encodings[i];
            const offset = 4 + i * 4;
            setEncodings[offset] = (enc >> 24) & 0xff;
            setEncodings[offset + 1] = (enc >> 16) & 0xff;
            setEncodings[offset + 2] = (enc >> 8) & 0xff;
            setEncodings[offset + 3] = enc & 0xff;
        }
        this.send(setEncodings);
        
        this.connected = true;
        this.state = 'connected';
        this.showStatus('');
        this.onConnect();
        console.log('VNC: connected! Screen size:', this.width, 'x', this.height);
        
        // Request initial full update
        this.requestUpdate(false);
        
        return 24 + nameLen;
    }
    
    requestUpdate(incremental) {
        if (!this.connected || this.frameRequestPending) return;
        
        const msg = new Uint8Array(10);
        msg[0] = 3; // FramebufferUpdateRequest
        msg[1] = incremental ? 1 : 0;
        msg[2] = 0; msg[3] = 0; // x
        msg[4] = 0; msg[5] = 0; // y
        msg[6] = (this.width >> 8) & 0xff;
        msg[7] = this.width & 0xff;
        msg[8] = (this.height >> 8) & 0xff;
        msg[9] = this.height & 0xff;
        this.send(msg);
        this.frameRequestPending = true;
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
                return 1; // Bell
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
        console.log('VNC: framebuffer update with', numRects, 'rectangles');
        
        for (let i = 0; i < numRects; i++) {
            if (this.buffer.length < offset + 12) return 0;
            
            const x = (this.buffer[offset] << 8) | this.buffer[offset + 1];
            const y = (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
            const w = (this.buffer[offset + 4] << 8) | this.buffer[offset + 5];
            const h = (this.buffer[offset + 6] << 8) | this.buffer[offset + 7];
            const encoding = this.readInt32(offset + 8);
            
            offset += 12;
            
            let consumed = 0;
            
            switch (encoding) {
                case 0: // Raw
                    consumed = this.handleRawRect(x, y, w, h, offset);
                    break;
                case 1: // CopyRect
                    consumed = this.handleCopyRect(x, y, w, h, offset);
                    break;
                case 2: // RRE
                    consumed = this.handleRRERect(x, y, w, h, offset);
                    break;
                case 5: // Hextile
                    consumed = this.handleHextileRect(x, y, w, h, offset);
                    break;
                case 16: // ZRLE
                    consumed = this.handleZRLERect(x, y, w, h, offset);
                    break;
                case -223: // DesktopSize
                    this.resize(w, h);
                    consumed = 0;
                    break;
                case -239: // Cursor
                    consumed = this.handleCursorPseudo(w, h, offset);
                    break;
                default:
                    // Unknown encoding - skip (QEMU shouldn't send unsupported encodings)
                    console.warn('VNC: Unknown encoding', encoding, 'at rect', i);
                    consumed = 0;
            }
            
            if (consumed === -1) return 0; // Need more data
            offset += consumed;
        }
        
        this.ctx.putImageData(this.frameBuffer, 0, 0);
        this.drawCursor();
        
        this.frameRequestPending = false;
        
        // Adaptive frame rate
        const now = performance.now();
        const frameTime = now - this.lastFrameTime;
        this.lastFrameTime = now;
        
        if (this.adaptiveFrameRate) {
            // Adjust interval based on network performance
            if (frameTime > this.currentFrameInterval * 1.5) {
                this.currentFrameInterval = Math.min(this.maxFrameInterval, this.currentFrameInterval * 1.2);
            } else if (frameTime < this.currentFrameInterval * 0.8) {
                this.currentFrameInterval = Math.max(this.minFrameInterval, this.currentFrameInterval * 0.9);
            }
        }
        
        setTimeout(() => this.requestUpdate(true), this.currentFrameInterval);
        
        return offset;
    }
    
    readInt32(offset) {
        const val = (this.buffer[offset] << 24) | (this.buffer[offset + 1] << 16) | 
               (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
        return val | 0; // Ensure signed 32-bit
    }
    
    handleRawRect(x, y, w, h, offset) {
        const pixelBytes = w * h * 4;
        if (this.buffer.length < offset + pixelBytes) return -1;
        
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const srcIdx = offset + (py * w + px) * 4;
                const dstIdx = ((y + py) * this.width + (x + px)) * 4;
                
                this.frameBuffer.data[dstIdx] = this.buffer[srcIdx + 2];     // R
                this.frameBuffer.data[dstIdx + 1] = this.buffer[srcIdx + 1]; // G
                this.frameBuffer.data[dstIdx + 2] = this.buffer[srcIdx];     // B
                this.frameBuffer.data[dstIdx + 3] = 255;
            }
        }
        
        return pixelBytes;
    }
    
    handleCopyRect(x, y, w, h, offset) {
        if (this.buffer.length < offset + 4) return -1;
        
        const srcX = (this.buffer[offset] << 8) | this.buffer[offset + 1];
        const srcY = (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
        
        // Copy pixels from source to destination
        const tempData = new Uint8ClampedArray(w * h * 4);
        
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const srcIdx = ((srcY + py) * this.width + (srcX + px)) * 4;
                const tmpIdx = (py * w + px) * 4;
                tempData[tmpIdx] = this.frameBuffer.data[srcIdx];
                tempData[tmpIdx + 1] = this.frameBuffer.data[srcIdx + 1];
                tempData[tmpIdx + 2] = this.frameBuffer.data[srcIdx + 2];
                tempData[tmpIdx + 3] = this.frameBuffer.data[srcIdx + 3];
            }
        }
        
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const dstIdx = ((y + py) * this.width + (x + px)) * 4;
                const tmpIdx = (py * w + px) * 4;
                this.frameBuffer.data[dstIdx] = tempData[tmpIdx];
                this.frameBuffer.data[dstIdx + 1] = tempData[tmpIdx + 1];
                this.frameBuffer.data[dstIdx + 2] = tempData[tmpIdx + 2];
                this.frameBuffer.data[dstIdx + 3] = tempData[tmpIdx + 3];
            }
        }
        
        return 4;
    }
    
    handleRRERect(x, y, w, h, offset) {
        if (this.buffer.length < offset + 8) return -1;
        
        const numSubrects = this.readInt32(offset);
        const bgColor = this.readPixel(offset + 4);
        
        const totalBytes = 8 + numSubrects * 12;
        if (this.buffer.length < offset + totalBytes) return -1;
        
        // Fill background
        this.fillRect(x, y, w, h, bgColor);
        
        // Draw subrectangles
        let subOffset = offset + 8;
        for (let i = 0; i < numSubrects; i++) {
            const color = this.readPixel(subOffset);
            const sx = (this.buffer[subOffset + 4] << 8) | this.buffer[subOffset + 5];
            const sy = (this.buffer[subOffset + 6] << 8) | this.buffer[subOffset + 7];
            const sw = (this.buffer[subOffset + 8] << 8) | this.buffer[subOffset + 9];
            const sh = (this.buffer[subOffset + 10] << 8) | this.buffer[subOffset + 11];
            this.fillRect(x + sx, y + sy, sw, sh, color);
            subOffset += 12;
        }
        
        return totalBytes;
    }
    
    handleHextileRect(x, y, w, h, offset) {
        const startOffset = offset;
        let bgColor = { r: 0, g: 0, b: 0 };
        let fgColor = { r: 255, g: 255, b: 255 };
        
        for (let tileY = 0; tileY < h; tileY += 16) {
            for (let tileX = 0; tileX < w; tileX += 16) {
                if (this.buffer.length < offset + 1) return -1;
                
                const tileW = Math.min(16, w - tileX);
                const tileH = Math.min(16, h - tileY);
                const subencoding = this.buffer[offset++];
                
                if (subencoding & 1) { // Raw
                    const bytes = tileW * tileH * 4;
                    if (this.buffer.length < offset + bytes) return -1;
                    
                    for (let py = 0; py < tileH; py++) {
                        for (let px = 0; px < tileW; px++) {
                            const srcIdx = offset + (py * tileW + px) * 4;
                            const dstIdx = ((y + tileY + py) * this.width + (x + tileX + px)) * 4;
                            this.frameBuffer.data[dstIdx] = this.buffer[srcIdx + 2];
                            this.frameBuffer.data[dstIdx + 1] = this.buffer[srcIdx + 1];
                            this.frameBuffer.data[dstIdx + 2] = this.buffer[srcIdx];
                            this.frameBuffer.data[dstIdx + 3] = 255;
                        }
                    }
                    offset += bytes;
                } else {
                    if (subencoding & 2) { // Background specified
                        if (this.buffer.length < offset + 4) return -1;
                        bgColor = this.readPixel(offset);
                        offset += 4;
                    }
                    
                    this.fillRect(x + tileX, y + tileY, tileW, tileH, bgColor);
                    
                    if (subencoding & 4) { // Foreground specified
                        if (this.buffer.length < offset + 4) return -1;
                        fgColor = this.readPixel(offset);
                        offset += 4;
                    }
                    
                    if (subencoding & 8) { // Any subrects
                        if (this.buffer.length < offset + 1) return -1;
                        const numSubrects = this.buffer[offset++];
                        const colored = !!(subencoding & 16);
                        
                        for (let i = 0; i < numSubrects; i++) {
                            let color = fgColor;
                            if (colored) {
                                if (this.buffer.length < offset + 4) return -1;
                                color = this.readPixel(offset);
                                offset += 4;
                            }
                            
                            if (this.buffer.length < offset + 2) return -1;
                            const xy = this.buffer[offset++];
                            const wh = this.buffer[offset++];
                            const sx = (xy >> 4) & 0x0f;
                            const sy = xy & 0x0f;
                            const sw = ((wh >> 4) & 0x0f) + 1;
                            const sh = (wh & 0x0f) + 1;
                            
                            this.fillRect(x + tileX + sx, y + tileY + sy, sw, sh, color);
                        }
                    }
                }
            }
        }
        
        return offset - startOffset;
    }
    
    handleZRLERect(x, y, w, h, offset) {
        if (this.buffer.length < offset + 4) return -1;
        
        const length = this.readInt32(offset);
        if (this.buffer.length < offset + 4 + length) return -1;
        
        // ZRLE data is zlib compressed - we need to decompress it
        // For now, fall back to requesting raw encoding if ZRLE fails
        try {
            const compressedData = this.buffer.slice(offset + 4, offset + 4 + length);
            const decompressed = this.inflateZlib(compressedData);
            
            if (decompressed) {
                this.decodeZRLETiles(x, y, w, h, decompressed);
            }
        } catch (e) {
            // If decompression fails, fill with gray
            this.fillRect(x, y, w, h, { r: 128, g: 128, b: 128 });
        }
        
        return 4 + length;
    }
    
    inflateZlib(data) {
        // Simple zlib decompression using DecompressionStream if available
        // For browsers without it, return null to trigger fallback
        if (typeof DecompressionStream === 'undefined') {
            return null;
        }
        
        try {
            // Synchronous fallback - just return null for now
            // Real implementation would use async decompression
            return null;
        } catch (e) {
            return null;
        }
    }
    
    decodeZRLETiles(x, y, w, h, data) {
        let offset = 0;
        
        for (let tileY = 0; tileY < h; tileY += 64) {
            for (let tileX = 0; tileX < w; tileX += 64) {
                const tileW = Math.min(64, w - tileX);
                const tileH = Math.min(64, h - tileY);
                
                if (offset >= data.length) return;
                
                const subencoding = data[offset++];
                
                if (subencoding === 0) {
                    // Raw pixels
                    for (let py = 0; py < tileH; py++) {
                        for (let px = 0; px < tileW; px++) {
                            if (offset + 3 > data.length) return;
                            const dstIdx = ((y + tileY + py) * this.width + (x + tileX + px)) * 4;
                            this.frameBuffer.data[dstIdx] = data[offset + 2];
                            this.frameBuffer.data[dstIdx + 1] = data[offset + 1];
                            this.frameBuffer.data[dstIdx + 2] = data[offset];
                            this.frameBuffer.data[dstIdx + 3] = 255;
                            offset += 3;
                        }
                    }
                } else if (subencoding === 1) {
                    // Solid color
                    if (offset + 3 > data.length) return;
                    const color = { r: data[offset + 2], g: data[offset + 1], b: data[offset] };
                    offset += 3;
                    this.fillRect(x + tileX, y + tileY, tileW, tileH, color);
                } else {
                    // Other subencodings - fill with placeholder
                    this.fillRect(x + tileX, y + tileY, tileW, tileH, { r: 64, g: 64, b: 64 });
                }
            }
        }
    }
    
    handleCursorPseudo(w, h, offset) {
        const pixelBytes = w * h * 4;
        const maskBytes = Math.ceil(w / 8) * h;
        const totalBytes = pixelBytes + maskBytes;
        
        if (this.buffer.length < offset + totalBytes) return -1;
        
        // Store cursor data for later drawing
        // For now, just skip it
        return totalBytes;
    }
    
    readPixel(offset) {
        return {
            b: this.buffer[offset],
            g: this.buffer[offset + 1],
            r: this.buffer[offset + 2]
        };
    }
    
    fillRect(x, y, w, h, color) {
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const dstIdx = ((y + py) * this.width + (x + px)) * 4;
                if (dstIdx >= 0 && dstIdx < this.frameBuffer.data.length - 3) {
                    this.frameBuffer.data[dstIdx] = color.r;
                    this.frameBuffer.data[dstIdx + 1] = color.g;
                    this.frameBuffer.data[dstIdx + 2] = color.b;
                    this.frameBuffer.data[dstIdx + 3] = 255;
                }
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
    
    handleMouseMove(e) {
        if (!this.connected) return;
        
        const now = performance.now();
        if (now - this.lastMouseSend < this.mouseThrottle) return;
        this.lastMouseSend = now;
        
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.width / rect.width;
        const scaleY = this.height / rect.height;
        
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        
        this.cursorX = x;
        this.cursorY = y;
        
        const buttonMask = (e.buttons & 1) | ((e.buttons & 2) << 1) | ((e.buttons & 4) >> 1);
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
        
        const now = performance.now();
        if (now - this.lastMouseSend < this.mouseThrottle) return;
        this.lastMouseSend = now;
        
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
        if (!this.connected) return;
        
        // Only draw local cursor if fallback is enabled
        if (!this.localCursorFallback) return;
        
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
    
    enableLocalCursor(enable = true) {
        this.localCursorFallback = enable;
        this.canvas.style.cursor = enable ? 'none' : 'default';
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
    
    setQuality(level) {
        this.qualityLevel = Math.max(0, Math.min(9, level));
    }
    
    setCompression(level) {
        this.compressionLevel = Math.max(0, Math.min(9, level));
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
