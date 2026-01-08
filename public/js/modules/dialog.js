const Dialog = {
    container: null,

    init() {
        this.container = document.createElement('div');
        this.container.id = 'dialog-container';
        document.body.appendChild(this.container);
    },

    _create(type, title, message, options = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';

            const dialog = document.createElement('div');
            dialog.className = `dialog dialog-${type}`;

            const iconMap = {
                alert: 'info-circle',
                success: 'check-circle',
                warning: 'exclamation-triangle',
                confirm: 'question-circle',
                prompt: 'edit'
            };

            let inputHtml = '';
            if (type === 'prompt') {
                inputHtml = `<input type="${options.inputType || 'text'}" 
                    class="dialog-input" 
                    placeholder="${options.placeholder || ''}"
                    value="${options.defaultValue || ''}">`;
            }

            dialog.innerHTML = `
                <div class="dialog-header">
                    <i class="fas fa-${iconMap[type]}"></i>
                    <span>${title || type.charAt(0).toUpperCase() + type.slice(1)}</span>
                </div>
                <div class="dialog-body">
                    <p>${message}</p>
                    ${inputHtml}
                </div>
                <div class="dialog-footer">
                    ${type === 'confirm' || type === 'prompt' ? 
                        `<button class="btn btn-secondary dialog-cancel">${options.cancelText || 'Cancelar'}</button>` : ''}
                    <button class="btn btn-primary dialog-ok">${options.okText || 'Aceptar'}</button>
                </div>
            `;

            overlay.appendChild(dialog);
            this.container.appendChild(overlay);

            requestAnimationFrame(() => {
                overlay.classList.add('active');
                dialog.classList.add('active');
            });

            const close = (result) => {
                overlay.classList.remove('active');
                dialog.classList.remove('active');
                setTimeout(() => {
                    overlay.remove();
                    resolve(result);
                }, 300);
            };

            const okBtn = dialog.querySelector('.dialog-ok');
            const cancelBtn = dialog.querySelector('.dialog-cancel');
            const input = dialog.querySelector('.dialog-input');

            okBtn.addEventListener('click', () => {
                if (type === 'prompt') {
                    close(input.value);
                } else if (type === 'confirm') {
                    close(true);
                } else {
                    close(true);
                }
            });

            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                    close(type === 'prompt' ? null : false);
                });
            }

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay && options.closeOnOverlay !== false) {
                    close(type === 'prompt' ? null : false);
                }
            });

            if (input) {
                input.focus();
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        close(input.value);
                    }
                });
            } else {
                okBtn.focus();
            }

            document.addEventListener('keydown', function escHandler(e) {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', escHandler);
                    close(type === 'prompt' ? null : false);
                }
            });
        });
    },

    alert(message, title = 'Información', options = {}) {
        return this._create('alert', title, message, options);
    },

    success(message, title = 'Éxito', options = {}) {
        return this._create('success', title, message, options);
    },

    warning(message, title = 'Advertencia', options = {}) {
        return this._create('warning', title, message, options);
    },

    confirm(message, title = 'Confirmar', options = {}) {
        return this._create('confirm', title, message, options);
    },

    prompt(message, title = 'Ingrese datos', options = {}) {
        return this._create('prompt', title, message, options);
    }
};

export default Dialog;
