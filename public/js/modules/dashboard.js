import Dialog from './dialog.js';
import API from './api.js';

const Dashboard = {
    async render(container, navigate) {
        container.innerHTML = '<div class="text-center mt-5">Loading dashboard...</div>';
        
        try {
            const data = await API.get('/api/dashboard');
            
            const tmpl = document.getElementById('dashboard-template').content.cloneNode(true);
            container.innerHTML = '';
            container.appendChild(tmpl);
            
            const runningCount = data.servers.filter(s => s.status === 'running').length;
            const stoppedCount = data.servers.filter(s => s.status === 'stopped').length;
            document.getElementById('dash-total-vms').textContent = data.servers.length;
            document.getElementById('dash-running-vms').textContent = runningCount;
            document.getElementById('dash-stopped-vms').textContent = stoppedCount;
            document.getElementById('dash-ram-used').textContent = `${data.stats?.totalRam || 0} MB`;
            
            const list = document.getElementById('server-list');
            const searchInput = document.getElementById('server-search');
            
            const renderServerList = (filter = '') => {
                const filtered = data.servers.filter(s => 
                    s.name.toLowerCase().includes(filter.toLowerCase()) ||
                    (s.image && s.image.toLowerCase().includes(filter.toLowerCase()))
                );
                
                if (filtered.length === 0) {
                    list.innerHTML = '<div class="text-center text-muted mt-3">No servers found</div>';
                    return;
                }
                
                list.innerHTML = '';
                filtered.forEach(s => {
                    const item = document.createElement('div');
                    item.className = 'vm-card';
                    item.onclick = () => navigate(`/server/${s.id}/console`);
                    
                    const statusClass = s.status === 'running' ? 'running' : (s.status === 'creating' ? 'creating' : 'stopped');
                    const statusText = s.status === 'running' ? 'Running' : (s.status === 'creating' ? 'Creating...' : 'Stopped');
                    
                    item.innerHTML = `
                        <div class="vm-card-header">
                            <div>
                                <div class="vm-card-title">${s.name}</div>
                                <div class="vm-card-subtitle">${s.image || 'Unknown OS'}</div>
                            </div>
                            <div class="d-flex align-center gap-2">
                                <span class="status-indicator ${statusClass}"></span>
                                <span class="badge ${statusClass}">${statusText}</span>
                            </div>
                        </div>
                        <div class="vm-card-stats">
                            <div class="vm-card-stat">
                                <span class="material-symbols-outlined">memory</span>
                                ${s.ram || 0} MB
                            </div>
                            <div class="vm-card-stat">
                                <span class="material-symbols-outlined">storage</span>
                                ${s.diskSize || '0G'}
                            </div>
                            <div class="vm-card-stat">
                                <span class="material-symbols-outlined">developer_board</span>
                                ${s.cpuLimit || 100}% CPU
                            </div>
                        </div>
                        <div class="vm-card-actions">
                            <button class="btn btn-xs btn-secondary view-btn" onclick="event.stopPropagation()">
                                <span class="material-symbols-outlined icon-xs">open_in_new</span>
                                Open
                            </button>
                            <button class="btn btn-xs btn-danger del-btn" onclick="event.stopPropagation()">
                                <span class="material-symbols-outlined icon-xs">delete</span>
                            </button>
                        </div>
                    `;
                    
                    item.querySelector('.view-btn').onclick = (e) => {
                        e.stopPropagation();
                        navigate(`/server/${s.id}/console`);
                    };
                    
                    item.querySelector('.del-btn').onclick = async (e) => {
                        e.stopPropagation();
                        const confirmed = await Dialog.confirm(
                            `Delete VM "${s.name}"? This will permanently delete all data!`,
                            'Delete VM',
                            { danger: true, confirmText: 'Delete' }
                        );
                        if (!confirmed) return;
                        
                        try {
                            await API.delete(`/api/server/${s.id}`);
                            this.render(container, navigate);
                        } catch (err) {
                            await Dialog.alert('Failed to delete server');
                        }
                    };
                    
                    list.appendChild(item);
                });
            };
            
            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    renderServerList(e.target.value);
                });
            }
            
            renderServerList();
            
        } catch (err) {
            console.error(err);
            container.innerHTML = '<div class="alert alert-danger">Error loading dashboard</div>';
        }
    }
};

export default Dashboard;
