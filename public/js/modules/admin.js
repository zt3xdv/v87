import Dialog from './dialog.js';
import API from './api.js';

const Admin = {
    async renderPanel(container, tab, navigate) {
        container.innerHTML = '<div class="text-center mt-5">Loading Admin Panel...</div>';
        
        const tmpl = document.getElementById('admin-layout-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const tabs = ['servers', 'users', 'nodes', 'audit', 'maintenance', 'config'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tab-${t}`);
            if (btn) {
                btn.className = `admin-pill ${t === tab ? 'active' : ''}`;
                btn.onclick = () => navigate(`/admin/${t}`);
            }
        });
        
        const content = document.getElementById('admin-content');
        
        if (tab === 'servers') {
            await this.renderServers(content, navigate);
        } else if (tab === 'users') {
            await this.renderUsers(content, navigate);
        } else if (tab === 'nodes') {
            await this.renderNodes(content, navigate);
        } else if (tab === 'audit') {
            await this.renderAudit(content);
        } else if (tab === 'maintenance') {
            await this.renderMaintenance(content);
        } else if (tab === 'config') {
            await this.renderConfig(content);
        }
    },

    async renderServers(container, navigate) {
        const tmpl = document.getElementById('admin-servers-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let currentPage = 1;
        let searchQuery = '';
        
        const loadServers = async () => {
            const listEl = document.getElementById('admin-servers-list');
            listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">hourglass_empty</span>Loading...</div>';
            
            try {
                const data = await API.get(`/api/admin/servers?page=${currentPage}&limit=12&search=${encodeURIComponent(searchQuery)}`);
                
                document.getElementById('admin-servers-count').textContent = `${data.total} VMs`;
                
                listEl.innerHTML = '';
                data.servers.forEach(s => {
                    const card = document.createElement('div');
                    card.className = 'admin-card';
                    card.innerHTML = `
                        <div class="admin-card-header">
                            <div class="admin-card-status ${s.status === 'running' ? 'status-running' : 'status-stopped'}"></div>
                            <span class="admin-card-title">${s.name}</span>
                        </div>
                        <div class="admin-card-body">
                            <div class="admin-card-info">
                                <span class="material-symbols-outlined">person</span>
                                <span>${s.ownerName}</span>
                            </div>
                            <div class="admin-card-info">
                                <span class="material-symbols-outlined">deployed_code</span>
                                <span>${s.imageName}</span>
                            </div>
                        </div>
                        <div class="admin-card-footer">
                            <span class="badge ${s.status === 'running' ? 'running' : 'stopped'}">${s.status.toUpperCase()}</span>
                            <button class="btn btn-sm btn-secondary edit-btn">
                                <span class="material-symbols-outlined icon-sm">edit</span>
                            </button>
                        </div>
                    `;
                    card.querySelector('.edit-btn').onclick = () => this.openServerEditModal(s, loadServers);
                    listEl.appendChild(card);
                });
                
                if (data.servers.length === 0) {
                    listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">dns</span>No VMs found</div>';
                }
                
                const paginationEl = document.getElementById('admin-servers-pagination');
                paginationEl.innerHTML = `
                    <button class="btn btn-sm btn-secondary" id="admin-servers-prev" ${currentPage <= 1 ? 'disabled' : ''}>
                        <span class="material-symbols-outlined icon-sm">chevron_left</span>
                    </button>
                    <span class="admin-pagination-info">Page ${data.page} of ${data.totalPages}</span>
                    <button class="btn btn-sm btn-secondary" id="admin-servers-next" ${currentPage >= data.totalPages ? 'disabled' : ''}>
                        <span class="material-symbols-outlined icon-sm">chevron_right</span>
                    </button>
                `;
                document.getElementById('admin-servers-prev').onclick = () => { currentPage--; loadServers(); };
                document.getElementById('admin-servers-next').onclick = () => { currentPage++; loadServers(); };
            } catch (e) {
                console.error(e);
                listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">error</span>Error loading servers</div>';
            }
        };
        
        document.getElementById('admin-server-search').oninput = (e) => {
            searchQuery = e.target.value;
            currentPage = 1;
            loadServers();
        };
        
        loadServers();
    },

    async renderUsers(container, navigate) {
        const tmpl = document.getElementById('admin-users-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let searchQuery = '';
        let allUsers = [];
        
        const renderUsers = () => {
            const listEl = document.getElementById('admin-users-list');
            const filtered = searchQuery 
                ? allUsers.filter(u => u.username.toLowerCase().includes(searchQuery.toLowerCase()))
                : allUsers;
            
            document.getElementById('admin-users-count').textContent = `${filtered.length} users`;
            
            listEl.innerHTML = '';
            filtered.forEach(u => {
                const card = document.createElement('div');
                card.className = 'admin-card admin-user-card';
                card.innerHTML = `
                    <div class="admin-card-header">
                        <div class="admin-user-avatar ${u.role === 'admin' ? 'avatar-admin' : ''}">
                            <span class="material-symbols-outlined">${u.role === 'admin' ? 'shield_person' : 'person'}</span>
                        </div>
                        <div class="admin-user-info">
                            <span class="admin-card-title">${u.username}</span>
                            <span class="badge ${u.role === 'admin' ? 'running' : 'stopped'}">${u.role.toUpperCase()}</span>
                        </div>
                    </div>
                    <div class="admin-card-body">
                        <div class="admin-card-stat">
                            <span class="material-symbols-outlined">computer</span>
                            <span>${u.serverCount} VMs</span>
                        </div>
                        <div class="admin-card-stat">
                            <span class="material-symbols-outlined">${u.suspended ? 'block' : 'check_circle'}</span>
                            <span class="${u.suspended ? 'text-danger' : 'text-success'}">${u.suspended ? 'Suspended' : 'Active'}</span>
                        </div>
                    </div>
                    <div class="admin-card-footer">
                        <button class="btn btn-sm btn-secondary edit-btn">
                            <span class="material-symbols-outlined icon-sm">edit</span>
                            Edit
                        </button>
                    </div>
                `;
                card.querySelector('.edit-btn').onclick = () => this.openUserEditModal(u.id, loadUsers);
                listEl.appendChild(card);
            });
            
            if (filtered.length === 0) {
                listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">group</span>No users found</div>';
            }
        };
        
        const loadUsers = async () => {
            const listEl = document.getElementById('admin-users-list');
            listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">hourglass_empty</span>Loading...</div>';
            
            try {
                allUsers = await API.get('/api/admin/users');
                renderUsers();
            } catch (e) {
                console.error(e);
                listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">error</span>Error loading users</div>';
            }
        };
        
        document.getElementById('admin-user-search').oninput = (e) => {
            searchQuery = e.target.value;
            renderUsers();
        };
        
        loadUsers();
    },

    async renderNodes(container, navigate) {
        container.innerHTML = `
            <div class="admin-section-header">
                <span class="admin-count" id="admin-nodes-count">0 nodes</span>
                <button id="btn-add-node" class="btn btn-sm btn-accent">
                    <span class="material-symbols-outlined icon-sm">add</span> Add Node
                </button>
            </div>
            <div id="admin-nodes-list" class="admin-cards-grid"></div>
        `;
        
        const loadNodes = async () => {
            const listEl = document.getElementById('admin-nodes-list');
            listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">hourglass_empty</span>Loading...</div>';
            
            try {
                const data = await API.get('/api/admin/nodes');
                
                document.getElementById('admin-nodes-count').textContent = `${data.nodes?.length || 0} nodes`;
                
                listEl.innerHTML = '';
                if (!data.nodes || data.nodes.length === 0) {
                    listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">dns</span>No nodes configured</div>';
                    return;
                }
                
                data.nodes.forEach(n => {
                    const ramUsed = n.availability?.ram?.used || 0;
                    const ramTotal = n.maxRam || 1;
                    const diskUsed = n.availability?.disk?.used || 0;
                    const diskTotal = n.maxDisk || 1;
                    const srvCount = n.availability?.servers?.count || 0;
                    const srvMax = n.maxServers || 1;
                    
                    const ramPercent = Math.min(100, Math.round((ramUsed / ramTotal) * 100));
                    const diskPercent = Math.min(100, Math.round((diskUsed / diskTotal) * 100));
                    const srvPercent = Math.min(100, Math.round((srvCount / srvMax) * 100));
                    
                    const card = document.createElement('div');
                    card.className = `admin-node-card ${!n.online ? 'offline' : ''}`;
                    card.innerHTML = `
                        <div class="admin-node-header">
                            <div>
                                <div class="admin-node-name">${n.name}</div>
                                <div class="admin-node-region">${n.region || 'default'}</div>
                            </div>
                            <div class="d-flex gap-1 align-center">
                                <span class="status-indicator ${n.online ? 'running' : 'stopped'}"></span>
                                <span class="badge ${n.online ? 'running' : 'stopped'}">${n.online ? 'Online' : 'Offline'}</span>
                                ${!n.enabled ? '<span class="badge suspended">Disabled</span>' : ''}
                            </div>
                        </div>
                        <div class="admin-node-resources">
                            <div class="admin-node-resource">
                                <span class="admin-node-resource-label">RAM</span>
                                <div class="admin-node-resource-bar">
                                    <div class="admin-node-resource-fill" style="width: ${ramPercent}%; background: linear-gradient(90deg, #7c3aed, #a78bfa);"></div>
                                </div>
                                <span class="admin-node-resource-value">${ramUsed}/${ramTotal} MB</span>
                            </div>
                            <div class="admin-node-resource">
                                <span class="admin-node-resource-label">Disk</span>
                                <div class="admin-node-resource-bar">
                                    <div class="admin-node-resource-fill" style="width: ${diskPercent}%; background: linear-gradient(90deg, #10b981, #34d399);"></div>
                                </div>
                                <span class="admin-node-resource-value">${diskUsed}/${diskTotal} GB</span>
                            </div>
                            <div class="admin-node-resource">
                                <span class="admin-node-resource-label">VMs</span>
                                <div class="admin-node-resource-bar">
                                    <div class="admin-node-resource-fill" style="width: ${srvPercent}%; background: linear-gradient(90deg, #f59e0b, #fbbf24);"></div>
                                </div>
                                <span class="admin-node-resource-value">${srvCount}/${srvMax}</span>
                            </div>
                        </div>
                        <div class="d-flex gap-2 mt-3">
                            <button class="btn btn-xs btn-secondary edit-btn flex-1">
                                <span class="material-symbols-outlined icon-xs">edit</span> Edit
                            </button>
                            <button class="btn btn-xs btn-secondary reconnect-btn" title="Reconnect">
                                <span class="material-symbols-outlined icon-xs">refresh</span>
                            </button>
                        </div>
                    `;
                    card.querySelector('.edit-btn').onclick = () => this.openNodeEditModal(n.id, loadNodes);
                    card.querySelector('.reconnect-btn').onclick = async () => {
                        await API.post(`/api/admin/nodes/${n.id}/reconnect`);
                        setTimeout(loadNodes, 1000);
                    };
                    listEl.appendChild(card);
                });
            } catch (e) {
                console.error(e);
                listEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">error</span>Error loading nodes</div>';
            }
        };
        
        document.getElementById('btn-add-node').onclick = () => this.openNodeEditModal(null, loadNodes);
        
        loadNodes();
    },

    async renderAudit(container) {
        const tmpl = document.getElementById('admin-audit-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        let offset = 0;
        const limit = 30;
        
        const getActionIcon = (action) => {
            const icons = {
                login: 'login',
                register: 'person_add',
                vm_create: 'add_circle',
                vm_delete: 'delete',
                vm_start: 'play_circle',
                vm_stop: 'stop_circle'
            };
            return icons[action] || 'info';
        };
        
        const getActionLabel = (action) => {
            const labels = {
                login: 'User Login',
                register: 'New Registration',
                vm_create: 'VM Created',
                vm_delete: 'VM Deleted',
                vm_start: 'VM Started',
                vm_stop: 'VM Stopped'
            };
            return labels[action] || action;
        };
        
        const loadLogs = async () => {
            const action = document.getElementById('audit-filter-action').value;
            const params = new URLSearchParams({ limit, offset });
            if (action) params.append('action', action);
            
            const timelineEl = document.getElementById('audit-logs-list');
            timelineEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">hourglass_empty</span>Loading...</div>';
            
            const logs = await API.get(`/api/admin/audit?${params}`);
            
            if (logs.length === 0) {
                timelineEl.innerHTML = '<div class="admin-empty-state"><span class="material-symbols-outlined">history</span>No audit logs found</div>';
            } else {
                timelineEl.innerHTML = logs.map(log => `
                    <div class="audit-item">
                        <div class="audit-icon ${log.action}">
                            <span class="material-symbols-outlined">${getActionIcon(log.action)}</span>
                        </div>
                        <div class="audit-content">
                            <div class="audit-header">
                                <span class="audit-action">${getActionLabel(log.action)}</span>
                                <span class="audit-time">${new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            <div class="audit-user">by ${log.username || 'Unknown'}</div>
                            ${log.serverName ? `<div class="audit-details">VM: ${log.serverName}</div>` : ''}
                        </div>
                    </div>
                `).join('');
            }
            
            document.getElementById('btn-audit-prev').disabled = offset === 0;
            document.getElementById('btn-audit-next').disabled = logs.length < limit;
        };
        
        await loadLogs();
        
        document.getElementById('audit-filter-action').onchange = () => { offset = 0; loadLogs(); };
        document.getElementById('btn-refresh-audit').onclick = loadLogs;
        document.getElementById('btn-audit-prev').onclick = () => { offset = Math.max(0, offset - limit); loadLogs(); };
        document.getElementById('btn-audit-next').onclick = () => { offset += limit; loadLogs(); };
    },

    async renderMaintenance(container) {
        const tmpl = document.getElementById('admin-maintenance-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        const settings = await API.get('/api/admin/settings');
        
        document.getElementById('setting-disable-registration').checked = settings.registrationDisabled;
        
        document.getElementById('btn-save-settings').onclick = async () => {
            const registrationDisabled = document.getElementById('setting-disable-registration').checked;
            
            await API.post('/api/admin/settings', { registrationDisabled });
            
            const successEl = document.getElementById('settings-success');
            successEl.classList.remove('hidden');
            setTimeout(() => successEl.classList.add('hidden'), 3000);
        };
        
        const data = await API.get('/api/admin/maintenance');
        
        document.getElementById('maint-enabled').checked = data.maintenance;
        document.getElementById('maint-message').value = data.message || '';
        
        const statusDiv = document.getElementById('maintenance-status');
        statusDiv.innerHTML = data.maintenance 
            ? '<div class="alert alert-warning"><span class="material-symbols-outlined icon-sm">warning</span> Maintenance mode is currently ENABLED</div>'
            : '<div class="alert alert-success"><span class="material-symbols-outlined icon-sm">check_circle</span> System is operating normally</div>';
        
        const [serversData, users] = await Promise.all([
            API.get('/api/admin/servers?limit=100'),
            API.get('/api/admin/users')
        ]);
        const servers = serversData.servers;
        
        document.getElementById('transfer-server').innerHTML = '<option value="">Select a VM</option>' + 
            servers.map(s => `<option value="${s.id}">${s.name} (${s.ownerName})</option>`).join('');
        document.getElementById('transfer-user').innerHTML = '<option value="">Select user</option>' +
            users.map(u => `<option value="${u.id}">${u.username}</option>`).join('');
        
        document.getElementById('btn-save-maintenance').onclick = async () => {
            const enabled = document.getElementById('maint-enabled').checked;
            const message = document.getElementById('maint-message').value;
            const stopAllVms = document.getElementById('maint-stop-vms').checked;
            
            await API.post('/api/admin/maintenance', { enabled, message, stopAllVms });
            
            this.renderMaintenance(container);
        };
        
        document.getElementById('btn-transfer-vm').onclick = async () => {
            const serverId = document.getElementById('transfer-server').value;
            const newOwnerId = document.getElementById('transfer-user').value;
            const statusEl = document.getElementById('transfer-status');
            
            if (!serverId || !newOwnerId) {
                statusEl.textContent = 'Select both VM and new owner';
                statusEl.className = 'text-sm ml-3 text-danger';
                return;
            }
            
            const res = await fetch(`/api/admin/server/${serverId}/transfer`, {
                method: 'POST',
                headers: API.headers(),
                body: JSON.stringify({ newOwnerId })
            });
            
            const result = await res.json();
            if (res.ok) {
                statusEl.textContent = result.message;
                statusEl.className = 'text-sm ml-3 text-success';
                this.renderMaintenance(container);
            } else {
                statusEl.textContent = result.error;
                statusEl.className = 'text-sm ml-3 text-danger';
            }
        };
    },

    async renderConfig(container) {
        const tmpl = document.getElementById('admin-config-template').content.cloneNode(true);
        container.innerHTML = '';
        container.appendChild(tmpl);
        
        try {
            const [config, stats] = await Promise.all([
                API.get('/api/admin/config'),
                API.get('/api/admin/stats')
            ]);
            
            document.getElementById('cfg-max-servers').value = config.limits?.maxServers || 3;
            document.getElementById('cfg-max-ram').value = config.limits?.maxRam || 2048;
            document.getElementById('cfg-max-disk').value = config.limits?.maxDisk || 50;
            document.getElementById('cfg-max-cpu').value = config.limits?.maxCpu || 400;
            document.getElementById('cfg-max-io').value = config.limits?.maxIo || 100;
            document.getElementById('cfg-min-ram').value = config.limits?.minRam || 512;
            document.getElementById('cfg-min-disk').value = config.limits?.minDisk || 5;
            document.getElementById('cfg-min-cpu').value = config.limits?.minCpu || 25;
            
            document.getElementById('cfg-def-ram').value = config.vm?.defaultRam || 1024;
            document.getElementById('cfg-def-disk').value = parseInt((config.vm?.defaultDisk || '10G').replace('G', ''));
            document.getElementById('cfg-def-cpu').value = config.vm?.defaultCpu || 100;
            document.getElementById('cfg-def-io').value = config.vm?.defaultIo || 0;
            
            document.getElementById('cfg-port').textContent = config.port || 3000;
            document.getElementById('cfg-total-users').textContent = stats.totalUsers;
            document.getElementById('cfg-total-servers').textContent = stats.totalServers;
            document.getElementById('cfg-running').textContent = stats.runningServers;
        } catch (e) { console.error(e); }
        
        document.getElementById('config-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            
            try {
                await API.post('/api/admin/config', {
                    limits: {
                        maxServers: parseInt(document.getElementById('cfg-max-servers').value),
                        maxRam: parseInt(document.getElementById('cfg-max-ram').value),
                        maxDisk: parseInt(document.getElementById('cfg-max-disk').value),
                        maxCpu: parseInt(document.getElementById('cfg-max-cpu').value),
                        maxIo: parseInt(document.getElementById('cfg-max-io').value),
                        minRam: parseInt(document.getElementById('cfg-min-ram').value),
                        minDisk: parseInt(document.getElementById('cfg-min-disk').value),
                        minCpu: parseInt(document.getElementById('cfg-min-cpu').value)
                    }
                });
                
                document.getElementById('config-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('config-success').classList.add('hidden'), 3000);
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
        };
        
        document.getElementById('defaults-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            
            try {
                await API.post('/api/admin/config', {
                    vm: {
                        defaultRam: parseInt(document.getElementById('cfg-def-ram').value),
                        defaultDisk: document.getElementById('cfg-def-disk').value + 'G',
                        defaultCpu: parseInt(document.getElementById('cfg-def-cpu').value),
                        defaultIo: parseInt(document.getElementById('cfg-def-io').value)
                    }
                });
                
                document.getElementById('config-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('config-success').classList.add('hidden'), 3000);
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
        };
        
        document.getElementById('btn-stop-all').onclick = async () => {
            const confirmed = await Dialog.confirm('Stop ALL running VMs? This will force stop every VM.', 'Stop All VMs', { danger: true, okText: 'Stop All' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-stop-all');
            btn.disabled = true;
            btn.textContent = 'Stopping...';
            
            try {
                await API.post('/api/admin/stop-all');
                
                const stats = await API.get('/api/admin/stats');
                document.getElementById('cfg-running').textContent = stats.runningServers;
            } catch (e) { console.error(e); }
            
            btn.disabled = false;
            btn.innerHTML = '<span class="material-symbols-outlined icon-sm">stop</span> Stop All VMs';
        };
    },

    async openServerEditModal(server, onSave) {
        const tmpl = document.getElementById('server-edit-template').content.cloneNode(true);
        document.body.appendChild(tmpl);
        
        const overlay = document.querySelector('.editor-overlay');
        
        document.getElementById('edit-server-title').textContent = `Edit: ${server.name}`;
        document.getElementById('edit-server-name').value = server.name;
        document.getElementById('edit-server-desc').value = server.description || '';
        document.getElementById('edit-server-suspended').checked = server.suspended || false;
        document.getElementById('edit-server-suspend-reason').value = server.suspendReason || '';
        
        const statusBadge = document.getElementById('edit-server-status');
        statusBadge.textContent = server.status?.toUpperCase() || 'STOPPED';
        statusBadge.className = `badge ${server.status === 'running' ? 'running' : 'stopped'}`;
        
        document.getElementById('edit-server-owner').textContent = server.ownerName || '-';
        document.getElementById('edit-server-image').textContent = server.imageName || '-';
        document.getElementById('edit-server-disk').textContent = server.diskSize || '-';
        
        document.getElementById('edit-server-ram').value = server.ram || 1024;
        document.getElementById('edit-server-cpu').value = server.cpuLimit || 100;
        document.getElementById('edit-server-io').value = server.ioLimit || 0;
        
        document.getElementById('btn-close-server-edit').onclick = () => overlay.remove();
        
        document.getElementById('btn-force-stop').onclick = async () => {
            const confirmed = await Dialog.confirm('Force stop this VM?', 'Force Stop', { danger: true, okText: 'Force Stop' });
            if (!confirmed) return;
            
            await API.post(`/api/admin/server/${server.id}/force-stop`);
            
            overlay.remove();
            onSave && onSave();
        };
        
        document.getElementById('btn-reinstall-admin').onclick = async () => {
            if (server.status === 'running') {
                await Dialog.warning('Stop the VM first');
                return;
            }
            const confirmed = await Dialog.confirm(`Reinstall ${server.name}? This will delete all disk data!`, 'Reinstall VM', { danger: true, okText: 'Reinstall' });
            if (!confirmed) return;
            
            await API.post(`/api/admin/server/${server.id}/reinstall`);
            
            overlay.remove();
            onSave && onSave();
        };
        
        document.getElementById('btn-delete-server-admin').onclick = async () => {
            const confirmed = await Dialog.confirm(`Delete VM ${server.name}? This cannot be undone!`, 'Delete VM', { danger: true, okText: 'Delete' });
            if (!confirmed) return;
            
            const res = await fetch(`/api/admin/server/${server.id}`, {
                method: 'DELETE',
                headers: API.headers()
            });
            
            if (res.ok) {
                overlay.remove();
                onSave && onSave();
            } else {
                const data = await res.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('server-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const suspended = document.getElementById('edit-server-suspended').checked;
            const suspendReason = document.getElementById('edit-server-suspend-reason').value;
            
            const payload = {
                name: document.getElementById('edit-server-name').value,
                description: document.getElementById('edit-server-desc').value,
                ram: parseInt(document.getElementById('edit-server-ram').value),
                cpuLimit: parseInt(document.getElementById('edit-server-cpu').value),
                ioLimit: parseInt(document.getElementById('edit-server-io').value)
            };
            
            await API.post(`/api/admin/server/${server.id}`, payload);
            
            await API.post(`/api/admin/server/${server.id}/suspend`, { suspended, reason: suspendReason });
            
            document.getElementById('server-edit-success').classList.remove('hidden');
            setTimeout(() => {
                overlay.remove();
                onSave && onSave();
            }, 500);
        };
    },

    async openUserEditModal(userId, onSave) {
        const res = await fetch(`/api/admin/user/${userId}`, {
            headers: API.headers()
        });
        if (!res.ok) { 
            await Dialog.warning('Failed to load user'); 
            return; 
        }
        const user = await res.json();
        
        const tmpl = document.getElementById('user-edit-template').content.cloneNode(true);
        document.body.appendChild(tmpl);
        
        const overlay = document.querySelector('.editor-overlay');
        
        document.getElementById('edit-user-title').textContent = `Edit: ${user.username}`;
        document.getElementById('edit-role').value = user.role;
        document.getElementById('edit-suspended').checked = user.suspended;
        document.getElementById('edit-suspend-reason').value = user.suspendReason || '';
        
        if (user.limits) {
            document.getElementById('edit-limit-servers').value = user.limits.maxServers || '';
            document.getElementById('edit-limit-ram').value = user.limits.maxRam || '';
            document.getElementById('edit-limit-disk').value = user.limits.maxDisk || '';
            document.getElementById('edit-limit-cpu').value = user.limits.maxCpu || '';
            document.getElementById('edit-limit-io').value = user.limits.maxIo || '';
        }
        
        const serversList = document.getElementById('user-servers-list');
        if (user.servers && user.servers.length > 0) {
            serversList.innerHTML = user.servers.map(s => `
                <div style="padding: 0.5rem; background: var(--bg-app); border-radius: 6px; margin-bottom: 0.5rem;">
                    <strong>${s.name}</strong> - ${s.ram} MB
                    <span class="badge ${s.suspended ? 'suspended' : (s.status === 'running' ? 'running' : 'stopped')}" style="margin-left: 0.5rem;">
                        ${s.suspended ? 'SUSPENDED' : s.status.toUpperCase()}
                    </span>
                </div>
            `).join('');
        } else {
            serversList.textContent = 'No VMs';
        }
        
        document.getElementById('btn-close-user-edit').onclick = () => overlay.remove();
        
        document.getElementById('btn-revoke-tokens').onclick = async () => {
            const confirmed = await Dialog.confirm(`Logout all sessions for ${user.username}?`, 'Logout Sessions', { danger: true, okText: 'Logout All' });
            if (!confirmed) return;
            
            const btn = document.getElementById('btn-revoke-tokens');
            btn.disabled = true;
            
            const revokeRes = await fetch(`/api/admin/user/${userId}/revoke-tokens`, {
                method: 'POST',
                headers: API.headers()
            });
            
            btn.disabled = false;
            
            if (revokeRes.ok) {
                document.getElementById('user-edit-success').textContent = 'All sessions logged out';
                document.getElementById('user-edit-success').classList.remove('hidden');
                setTimeout(() => document.getElementById('user-edit-success').classList.add('hidden'), 2000);
            } else {
                const data = await revokeRes.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('btn-delete-user').onclick = async () => {
            const confirmed = await Dialog.confirm(`Delete user ${user.username}? This will delete all their VMs!`, 'Delete User', { danger: true, okText: 'Delete' });
            if (!confirmed) return;
            
            const deleteRes = await fetch(`/api/admin/user/${userId}`, {
                method: 'DELETE',
                headers: API.headers()
            });
            
            if (deleteRes.ok) {
                overlay.remove();
                onSave && onSave();
            } else {
                const data = await deleteRes.json();
                await Dialog.warning('Error: ' + data.error);
            }
        };
        
        document.getElementById('user-edit-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const limits = {};
            const maxServers = document.getElementById('edit-limit-servers').value;
            const maxRam = document.getElementById('edit-limit-ram').value;
            const maxDisk = document.getElementById('edit-limit-disk').value;
            const maxCpu = document.getElementById('edit-limit-cpu').value;
            const maxIo = document.getElementById('edit-limit-io').value;
            
            if (maxServers) limits.maxServers = parseInt(maxServers);
            if (maxRam) limits.maxRam = parseInt(maxRam);
            if (maxDisk) limits.maxDisk = parseInt(maxDisk);
            if (maxCpu) limits.maxCpu = parseInt(maxCpu);
            if (maxIo) limits.maxIo = parseInt(maxIo);
            
            const payload = {
                role: document.getElementById('edit-role').value,
                suspended: document.getElementById('edit-suspended').checked,
                suspendReason: document.getElementById('edit-suspend-reason').value,
                limits: Object.keys(limits).length > 0 ? limits : null
            };
            
            const saveRes = await fetch(`/api/admin/user/${userId}`, {
                method: 'POST',
                headers: API.headers(),
                body: JSON.stringify(payload)
            });
            
            if (saveRes.ok) {
                document.getElementById('user-edit-success').classList.remove('hidden');
                setTimeout(() => {
                    overlay.remove();
                    onSave && onSave();
                }, 500);
            } else {
                const data = await saveRes.json();
                document.getElementById('user-edit-error').textContent = data.error;
                document.getElementById('user-edit-error').classList.remove('hidden');
            }
        };
    },

    async openNodeEditModal(nodeId, onSave) {
        const isNew = !nodeId;
        let node = { name: '', url: '', secret: '', region: 'default', maxRam: 8192, maxDisk: 100, maxCpu: 8, maxServers: 10, enabled: true };
        
        if (!isNew) {
            try {
                node = await API.get(`/api/admin/nodes/${nodeId}`);
            } catch (e) {
                Dialog.warning('Failed to load node', 'Error');
                return;
            }
        }
        
        const modalHtml = `
            <div class="modal-overlay" id="node-modal">
                <div class="modal-content" style="max-width:500px">
                    <div class="modal-header">
                        <h3>${isNew ? 'Add Node' : 'Edit Node'}</h3>
                        <button class="btn-close" onclick="document.getElementById('node-modal').remove()">&times;</button>
                    </div>
                    <form id="node-form">
                        <div class="form-group">
                            <label>Name</label>
                            <input type="text" id="node-name" class="form-control" value="${node.name}" required>
                        </div>
                        <div class="form-group">
                            <label>WebSocket URL</label>
                            <input type="text" id="node-url" class="form-control" value="${node.url || ''}" placeholder="ws://host:7000" required>
                        </div>
                        <div class="form-group">
                            <label>Secret Key</label>
                            <input type="text" id="node-secret" class="form-control" value="" placeholder="${isNew ? 'Required' : 'Leave empty to keep current'}">
                        </div>
                        <div class="form-group">
                            <label>Region</label>
                            <input type="text" id="node-region" class="form-control" value="${node.region || 'default'}">
                        </div>
                        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                            <div class="form-group">
                                <label>Max RAM (MB)</label>
                                <input type="number" id="node-maxram" class="form-control" value="${node.maxRam || 8192}">
                            </div>
                            <div class="form-group">
                                <label>Max Disk (GB)</label>
                                <input type="number" id="node-maxdisk" class="form-control" value="${node.maxDisk || 100}">
                            </div>
                        </div>
                        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                            <div class="form-group">
                                <label>Max CPU Cores</label>
                                <input type="number" id="node-maxcpu" class="form-control" value="${node.maxCpu || 8}">
                            </div>
                            <div class="form-group">
                                <label>Max Servers</label>
                                <input type="number" id="node-maxservers" class="form-control" value="${node.maxServers || 10}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="checkbox-label">
                                <input type="checkbox" id="node-enabled" ${node.enabled ? 'checked' : ''}> Enabled
                            </label>
                        </div>
                        <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
                            ${!isNew ? '<button type="button" id="btn-delete-node" class="btn btn-danger">Delete</button>' : ''}
                            <button type="button" onclick="document.getElementById('node-modal').remove()" class="btn btn-secondary">Cancel</button>
                            <button type="submit" class="btn btn-primary">Save</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        document.getElementById('node-form').onsubmit = async (e) => {
            e.preventDefault();
            
            const payload = {
                name: document.getElementById('node-name').value,
                url: document.getElementById('node-url').value,
                region: document.getElementById('node-region').value,
                maxRam: parseInt(document.getElementById('node-maxram').value),
                maxDisk: parseInt(document.getElementById('node-maxdisk').value),
                maxCpu: parseInt(document.getElementById('node-maxcpu').value),
                maxServers: parseInt(document.getElementById('node-maxservers').value),
                enabled: document.getElementById('node-enabled').checked
            };
            
            const secret = document.getElementById('node-secret').value;
            if (secret || isNew) {
                payload.secret = secret;
            }
            
            try {
                const res = await fetch(isNew ? '/api/admin/nodes' : `/api/admin/nodes/${nodeId}`, {
                    method: isNew ? 'POST' : 'PUT',
                    headers: API.headers(),
                    body: JSON.stringify(payload)
                });
                
                if (!res.ok) {
                    const err = await res.json();
                    Dialog.warning(err.error || 'Failed to save node', 'Error');
                    return;
                }
                
                document.getElementById('node-modal').remove();
                onSave && onSave();
            } catch (e) {
                Dialog.warning('Failed to save node', 'Error');
            }
        };
        
        if (!isNew) {
            document.getElementById('btn-delete-node').onclick = async () => {
                const confirmed = await Dialog.confirm('Delete this node? VMs must be migrated first.', 'Delete Node', { danger: true, okText: 'Delete' });
                if (!confirmed) return;
                
                try {
                    const res = await fetch(`/api/admin/nodes/${nodeId}`, {
                        method: 'DELETE',
                        headers: API.headers()
                    });
                    
                    if (!res.ok) {
                        const err = await res.json();
                        Dialog.warning(err.error || 'Failed to delete node', 'Error');
                        return;
                    }
                    
                    document.getElementById('node-modal').remove();
                    onSave && onSave();
                } catch (e) {
                    Dialog.warning('Failed to delete node', 'Error');
                }
            };
        }
    }
};

export default Admin;
