import Dialog from './dialog.js';
import API from './api.js';

const Create = {
    async render(container, navigate) {
        container.innerHTML = '<div class="text-center mt-5">Loading...</div>';
        
        try {
            const [dashData, imagesData] = await Promise.all([
                API.get('/api/dashboard'),
                API.get('/api/images')
            ]);
            
            const tmpl = document.getElementById('create-template').content.cloneNode(true);
            container.innerHTML = '';
            container.appendChild(tmpl);
            
            document.getElementById('d-ram').textContent = dashData.stats.totalRam;
            document.getElementById('d-max-ram').textContent = dashData.stats.maxRam;
            document.getElementById('d-cpu').textContent = dashData.stats.totalCpu;
            document.getElementById('d-max-cpu').textContent = dashData.stats.maxCpu;
            document.getElementById('d-disk').textContent = dashData.stats.totalDisk;
            document.getElementById('d-max-disk').textContent = dashData.stats.maxDisk;
            document.getElementById('d-slots').textContent = dashData.stats.slotsUsed;
            document.getElementById('d-max-slots').textContent = dashData.stats.slotsMax;

            const ramInput = document.getElementById('c-ram');
            const diskInput = document.getElementById('c-disk');
            const cpuInput = document.getElementById('c-cpu');
            const ioInput = document.getElementById('c-io');
            
            const availableRam = dashData.stats.availableRam || 0;
            const availableCpu = dashData.stats.availableCpu || 0;
            const availableDisk = dashData.stats.availableDisk || 0;
            
            ramInput.min = 1;
            ramInput.max = availableRam;
            ramInput.value = Math.min(dashData.defaults?.ram || 1024, availableRam);
            
            diskInput.min = 1;
            diskInput.max = availableDisk;
            diskInput.value = Math.min(dashData.defaults?.disk || 10, availableDisk);
            
            cpuInput.min = 1;
            cpuInput.max = availableCpu;
            cpuInput.value = Math.min(dashData.defaults?.cpu || 100, availableCpu);
            
            ioInput.max = dashData.stats.maxIo || 100;
            ioInput.value = dashData.defaults?.io || 0;

            const imageSelect = document.getElementById('c-image');
            imageSelect.innerHTML = '<option value="">Select a Linux distribution...</option>';
            if (imagesData.images && imagesData.images.length > 0) {
                imagesData.images.forEach(img => {
                    const opt = document.createElement('option');
                    opt.value = img.id;
                    opt.textContent = `${img.name} - ${img.description}`;
                    imageSelect.appendChild(opt);
                });
            }
            
            const loadNodes = async () => {
                const ram = parseInt(ramInput.value) || 1024;
                const disk = parseInt(diskInput.value) || 10;
                const cpu = Math.ceil((parseInt(cpuInput.value) || 100) / 100);
                
                try {
                    const nodesData = await API.get(`/api/nodes?ram=${ram}&disk=${disk}&cpu=${cpu}`);
                    
                    const nodeSelect = document.getElementById('c-node');
                    const nodeGroup = document.getElementById('node-select-group');
                    const hint = document.getElementById('node-availability-hint');
                    
                    if (nodesData.nodes && nodesData.nodes.length > 0) {
                        nodeGroup.style.display = 'block';
                        nodeSelect.innerHTML = '<option value="">Auto-select (best available)</option>';
                        
                        nodesData.nodes.forEach(n => {
                            const opt = document.createElement('option');
                            opt.value = n.id;
                            opt.textContent = `${n.name} (${n.region}) - ${n.availability?.ram?.available}MB free`;
                            if (!n.online) {
                                opt.textContent += ' [OFFLINE]';
                                opt.disabled = true;
                            }
                            nodeSelect.appendChild(opt);
                        });
                        
                        hint.textContent = `${nodesData.nodes.filter(n => n.online).length} node(s) available for this configuration`;
                    } else {
                        nodeGroup.style.display = 'none';
                        hint.textContent = '';
                    }
                } catch (e) {
                    console.error('Failed to load nodes', e);
                }
            };
            
            loadNodes();
            ramInput.addEventListener('change', loadNodes);
            diskInput.addEventListener('change', loadNodes);
            cpuInput.addEventListener('change', loadNodes);

            document.getElementById('create-server-form').onsubmit = async (e) => {
                e.preventDefault();
                
                const nameInput = document.getElementById('c-name');
                const name = nameInput.value.trim();
                const err = document.getElementById('create-error');
                
                if (name.length < 3) {
                    err.textContent = 'Server name must be at least 3 characters';
                    err.classList.remove('hidden');
                    nameInput.focus();
                    return;
                }
                
                const imageId = document.getElementById('c-image').value;
                if (!imageId) {
                    err.textContent = 'Please select a Linux distribution';
                    err.classList.remove('hidden');
                    return;
                }
                
                const diskValue = parseInt(document.getElementById('c-disk').value) || 10;
                const nodeId = document.getElementById('c-node')?.value || null;
                const payload = {
                    name: name,
                    description: document.getElementById('c-desc').value,
                    imageId: imageId,
                    ram: parseInt(document.getElementById('c-ram').value) || 1024,
                    diskSize: `${diskValue}G`,
                    cpuLimit: parseInt(document.getElementById('c-cpu').value) || 100,
                    ioLimit: parseInt(document.getElementById('c-io').value) || 0
                };
                if (nodeId) payload.nodeId = nodeId;
                
                err.classList.add('hidden');
                
                try {
                    const result = await API.post('/api/server/create', payload);
                    if (result.success) {
                        navigate(`/server/${result.server.id}/creating`);
                    } else {
                        err.textContent = result.error || 'Failed to create server';
                        err.classList.remove('hidden');
                    }
                } catch (error) {
                    err.textContent = error.message || 'Failed to create server';
                    err.classList.remove('hidden');
                }
            };
        } catch (err) {
            console.error(err);
            container.innerHTML = '<div class="alert alert-danger">Error loading create form</div>';
        }
    }
};

export default Create;
