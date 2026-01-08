import Dialog from './dialog.js';
import API from './api.js';

const Auth = {
    renderLogin(container, navigate, setUser) {
        const tmpl = document.getElementById('login-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('login-form').onsubmit = async (e) => {
            e.preventDefault();
            const u = document.getElementById('l-username').value;
            const p = document.getElementById('l-password').value;
            
            try {
                const data = await API.post('/api/login', { username: u, password: p });
                if (data.success) {
                    setUser(data.user);
                    localStorage.setItem('token', data.token);
                    navigate('/dashboard');
                } else {
                    const err = document.getElementById('login-error');
                    err.textContent = data.error;
                    err.classList.remove('hidden');
                }
            } catch (error) {
                const err = document.getElementById('login-error');
                err.textContent = error.message || 'Login failed';
                err.classList.remove('hidden');
            }
        };
    },

    renderRegister(container, navigate, setUser) {
        const tmpl = document.getElementById('register-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);

        document.getElementById('register-form').onsubmit = async (e) => {
            e.preventDefault();
            const u = document.getElementById('r-username').value;
            const p = document.getElementById('r-password').value;

            try {
                const data = await API.post('/api/register', { username: u, password: p });
                if (data.success) {
                    setUser(data.user);
                    localStorage.setItem('token', data.token);
                    navigate('/dashboard');
                } else {
                    const err = document.getElementById('reg-error');
                    err.textContent = data.error;
                    err.classList.remove('hidden');
                }
            } catch (error) {
                const err = document.getElementById('reg-error');
                err.textContent = error.message || 'Registration failed';
                err.classList.remove('hidden');
            }
        };
    },

    async renderAccountPage(container, navigate, user, tab = 'apikeys', setTheme, getTheme) {
        const tmpl = document.getElementById('account-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        document.getElementById('account-username').textContent = user?.username || 'User';
        document.getElementById('account-role').textContent = user?.role === 'admin' ? 'Administrator' : 'Member';
        
        const tabs = ['apikeys', 'webhooks', 'prefs', 'activity'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tab-${t}`);
            btn.className = `account-pill ${t === tab ? 'active' : ''}`;
            btn.onclick = () => navigate(`/account/${t}`);
        });
        
        const content = document.getElementById('account-content');
        
        if (tab === 'apikeys') await this.renderApiKeys(content);
        else if (tab === 'webhooks') await this.renderWebhooks(content);
        else if (tab === 'prefs') await this.renderPreferences(content, navigate, setTheme, getTheme);
        else if (tab === 'activity') await this.renderActivity(content);
    },
    
    async renderApiKeys(container) {
        const tmpl = document.getElementById('apikeys-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadKeys = async () => {
            try {
                const data = await API.get('/api/keys');
                const list = document.getElementById('apikeys-list');
                
                if (data.keys && data.keys.length > 0) {
                    list.innerHTML = data.keys.map(k => `
                        <div class="account-item">
                            <div class="account-item-icon">
                                <span class="material-symbols-outlined">key</span>
                            </div>
                            <div class="account-item-content">
                                <div class="account-item-name">${k.name}</div>
                                <div class="account-item-meta">
                                    <code>${k.prefix}</code>
                                    <span>${k.permissions.join(', ')}</span>
                                    ${k.lastUsed ? `<span>Last used: ${new Date(k.lastUsed).toLocaleDateString()}</span>` : ''}
                                </div>
                            </div>
                            <div class="account-item-actions">
                                <button class="btn btn-sm btn-danger btn-delete-key" data-id="${k.id}">
                                    <span class="material-symbols-outlined icon-sm">delete</span>
                                </button>
                            </div>
                        </div>
                    `).join('');
                    
                    list.querySelectorAll('.btn-delete-key').forEach(btn => {
                        btn.onclick = async () => {
                            const confirmed = await Dialog.confirm('Delete this API key?', 'Delete API Key', { danger: true, confirmText: 'Delete' });
                            if (!confirmed) return;
                            await API.delete(`/api/keys/${btn.dataset.id}`);
                            loadKeys();
                        };
                    });
                } else {
                    list.innerHTML = '<div class="account-empty-state"><span class="material-symbols-outlined">key_off</span><p>No API keys yet</p></div>';
                }
            } catch (error) {
                console.error('Failed to load API keys:', error);
            }
        };
        
        await loadKeys();
        
        document.getElementById('btn-create-key').onclick = () => {
            document.getElementById('create-key-form').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-key').onclick = () => {
            document.getElementById('create-key-form').classList.add('hidden');
        };
        
        document.getElementById('btn-save-key').onclick = async () => {
            const name = document.getElementById('key-name').value || 'API Key';
            const permissions = [];
            if (document.getElementById('key-perm-read').checked) permissions.push('read');
            if (document.getElementById('key-perm-write').checked) permissions.push('write');
            
            const data = await API.post('/api/keys', { name, permissions });
            
            if (data.key) {
                document.getElementById('new-key-value').textContent = data.key;
                document.getElementById('new-key-alert').classList.remove('hidden');
            }
            
            document.getElementById('create-key-form').classList.add('hidden');
            loadKeys();
        };
    },
    
    async renderWebhooks(container) {
        const tmpl = document.getElementById('webhooks-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const loadWebhooks = async () => {
            try {
                const data = await API.get('/api/webhooks');
                const list = document.getElementById('webhooks-list');
                
                if (data.webhooks && data.webhooks.length > 0) {
                    list.innerHTML = data.webhooks.map(w => `
                        <div class="account-item">
                            <div class="account-item-icon webhook">
                                <span class="material-symbols-outlined">webhook</span>
                            </div>
                            <div class="account-item-content">
                                <div class="account-item-name">
                                    ${w.name}
                                    <span class="badge ml-2 ${w.enabled ? 'running' : 'stopped'}">${w.enabled ? 'Active' : 'Disabled'}</span>
                                </div>
                                <div class="account-item-meta">
                                    <span style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${w.url}</span>
                                </div>
                                <div class="d-flex gap-1 mt-1 flex-wrap">${w.events.map(e => `<span class="badge" style="font-size: 0.65rem;">${e}</span>`).join('')}</div>
                            </div>
                            <div class="account-item-actions">
                                <button class="btn btn-sm btn-secondary btn-test-wh" data-id="${w.id}" title="Test">
                                    <span class="material-symbols-outlined icon-sm">send</span>
                                </button>
                                <button class="btn btn-sm btn-danger btn-delete-wh" data-id="${w.id}">
                                    <span class="material-symbols-outlined icon-sm">delete</span>
                                </button>
                            </div>
                        </div>
                    `).join('');
                    
                    list.querySelectorAll('.btn-test-wh').forEach(btn => {
                        btn.onclick = async () => {
                            btn.disabled = true;
                            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">hourglass_empty</span>';
                            
                            try {
                                const data = await API.post(`/api/webhooks/${btn.dataset.id}/test`);
                                
                                btn.disabled = false;
                                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">send</span>';
                                
                                if (data.success) {
                                    await Dialog.success('Webhook test successful!');
                                } else {
                                    await Dialog.warning('Webhook test failed: ' + (data.error || 'Unknown error'));
                                }
                            } catch (error) {
                                btn.disabled = false;
                                btn.innerHTML = '<span class="material-symbols-outlined icon-sm">send</span>';
                                await Dialog.warning('Webhook test failed: ' + error.message);
                            }
                        };
                    });
                    
                    list.querySelectorAll('.btn-delete-wh').forEach(btn => {
                        btn.onclick = async () => {
                            const confirmed = await Dialog.confirm('Delete this webhook?', 'Delete Webhook', { danger: true, confirmText: 'Delete' });
                            if (!confirmed) return;
                            await API.delete(`/api/webhooks/${btn.dataset.id}`);
                            loadWebhooks();
                        };
                    });
                } else {
                    list.innerHTML = '<div class="account-empty-state"><span class="material-symbols-outlined">webhook</span><p>No webhooks yet</p></div>';
                }
            } catch (error) {
                console.error('Failed to load webhooks:', error);
            }
        };
        
        await loadWebhooks();
        
        document.getElementById('btn-create-webhook').onclick = () => {
            document.getElementById('create-webhook-form').classList.remove('hidden');
        };
        
        document.getElementById('btn-cancel-webhook').onclick = () => {
            document.getElementById('create-webhook-form').classList.add('hidden');
        };
        
        document.getElementById('btn-save-webhook').onclick = async () => {
            const name = document.getElementById('wh-name').value || 'Webhook';
            const url = document.getElementById('wh-url').value;
            const secret = document.getElementById('wh-secret').value;
            const events = Array.from(document.querySelectorAll('.wh-event:checked')).map(c => c.value);
            
            if (!url) { await Dialog.warning('URL is required'); return; }
            if (events.length === 0) { await Dialog.warning('Select at least one event'); return; }
            
            await API.post('/api/webhooks', { name, url, secret, events });
            
            document.getElementById('create-webhook-form').classList.add('hidden');
            loadWebhooks();
        };
    },
    
    async renderPreferences(container, navigate, setTheme, getTheme) {
        const tmpl = document.getElementById('preferences-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        try {
            const data = await API.get('/api/preferences');
            const prefs = data.preferences || {};
            
            document.getElementById('pref-theme').value = getTheme();
            document.getElementById('pref-font-size').value = prefs.terminalFontSize || 14;
            document.getElementById('pref-default-view').value = prefs.defaultView || 'console';
            document.getElementById('pref-notifications').checked = prefs.notifications || false;
            
            document.getElementById('pref-theme').onchange = (e) => {
                setTheme(e.target.value);
            };
            
            document.getElementById('btn-save-prefs').onclick = async () => {
                const theme = document.getElementById('pref-theme').value;
                const terminalFontSize = parseInt(document.getElementById('pref-font-size').value);
                const defaultView = document.getElementById('pref-default-view').value;
                const notifications = document.getElementById('pref-notifications').checked;
                
                setTheme(theme);
                
                await API.post('/api/preferences', { theme, terminalFontSize, defaultView, notifications });
                
                document.getElementById('prefs-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('prefs-success').classList.add('hidden'), 2000);
            };
            
            document.getElementById('btn-revoke-all-sessions').onclick = async () => {
                const confirmed = await Dialog.confirm('This will log you out from all devices. Continue?', 'Logout All Sessions', { danger: true, confirmText: 'Logout All' });
                if (!confirmed) return;
                
                const btn = document.getElementById('btn-revoke-all-sessions');
                btn.disabled = true;
                btn.textContent = 'Logging out...';
                
                try {
                    await API.post('/api/revoke-tokens');
                    localStorage.removeItem('token');
                    navigate('/login');
                } catch (e) {
                    btn.disabled = false;
                    btn.innerHTML = '<span class="material-symbols-outlined icon-sm">logout</span> Logout All Sessions';
                }
            };
        } catch (error) {
            console.error('Failed to load preferences:', error);
        }
    },
    
    async renderActivity(container) {
        const tmpl = document.getElementById('activity-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let offset = 0;
        const limit = 20;
        
        const getActionIcon = (action) => {
            const icons = {
                login: 'login',
                vm_create: 'add_circle',
                vm_delete: 'delete',
                vm_start: 'play_circle',
                vm_stop: 'stop_circle'
            };
            return icons[action] || 'info';
        };
        
        const getActionLabel = (action) => {
            const labels = {
                login: 'Logged in',
                vm_create: 'Created VM',
                vm_delete: 'Deleted VM',
                vm_start: 'Started VM',
                vm_stop: 'Stopped VM'
            };
            return labels[action] || action;
        };
        
        const loadActivity = async (append = false) => {
            try {
                const logs = await API.get(`/api/activity?limit=${limit}&offset=${offset}`);
                const list = document.getElementById('activity-list');
                
                const html = logs.map(log => `
                    <div class="audit-item">
                        <div class="audit-icon ${log.action}">
                            <span class="material-symbols-outlined">${getActionIcon(log.action)}</span>
                        </div>
                        <div class="audit-content">
                            <div class="audit-header">
                                <span class="audit-action">${getActionLabel(log.action)}</span>
                                <span class="audit-time">${new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            ${log.serverName ? `<div class="audit-details">VM: ${log.serverName}</div>` : ''}
                        </div>
                    </div>
                `).join('');
                
                if (append) {
                    list.innerHTML += html;
                } else {
                    list.innerHTML = html || '<div class="account-empty-state"><span class="material-symbols-outlined">history</span><p>No activity yet</p></div>';
                }
                
                document.getElementById('btn-load-more-activity').style.display = logs.length < limit ? 'none' : 'flex';
            } catch (error) {
                console.error('Failed to load activity:', error);
            }
        };
        
        await loadActivity();
        
        document.getElementById('btn-load-more-activity').onclick = () => {
            offset += limit;
            loadActivity(true);
        };
    }
};

export default Auth;
