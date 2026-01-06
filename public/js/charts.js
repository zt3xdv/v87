const Charts = {
    instances: {},
    
    defaultOptions: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: false
            },
            tooltip: {
                backgroundColor: '#18181b',
                titleColor: '#fafafa',
                bodyColor: '#a1a1aa',
                borderColor: '#27272a',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 8,
                displayColors: false
            }
        },
        scales: {
            x: {
                display: false,
                grid: { display: false }
            },
            y: {
                display: true,
                grid: {
                    color: 'rgba(255,255,255,0.05)',
                    drawBorder: false
                },
                ticks: {
                    color: '#52525b',
                    font: { size: 10 },
                    padding: 8
                }
            }
        }
    },
    
    getGradient(ctx, color1, color2) {
        const gradient = ctx.createLinearGradient(0, 0, 0, 200);
        gradient.addColorStop(0, color1);
        gradient.addColorStop(1, color2);
        return gradient;
    },
    
    createLineChart(canvasId, label, color = '#7c3aed', maxPoints = 30) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        
        if (this.instances[canvasId]) {
            this.instances[canvasId].destroy();
        }
        
        const ctx = canvas.getContext('2d');
        const gradient = this.getGradient(ctx, `${color}40`, `${color}05`);
        
        this.instances[canvasId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: Array(maxPoints).fill(''),
                datasets: [{
                    label: label,
                    data: Array(maxPoints).fill(0),
                    borderColor: color,
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBackgroundColor: color
                }]
            },
            options: {
                ...this.defaultOptions,
                scales: {
                    ...this.defaultOptions.scales,
                    y: {
                        ...this.defaultOptions.scales.y,
                        min: 0,
                        max: 100,
                        ticks: {
                            ...this.defaultOptions.scales.y.ticks,
                            callback: (value) => value + '%'
                        }
                    }
                }
            }
        });
        
        return this.instances[canvasId];
    },
    
    createDoughnutChart(canvasId, data, colors) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        
        if (this.instances[canvasId]) {
            this.instances[canvasId].destroy();
        }
        
        const ctx = canvas.getContext('2d');
        
        this.instances[canvasId] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.values,
                    backgroundColor: colors,
                    borderColor: '#09090b',
                    borderWidth: 3,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            color: '#a1a1aa',
                            font: { size: 11 },
                            padding: 15,
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        backgroundColor: '#18181b',
                        titleColor: '#fafafa',
                        bodyColor: '#a1a1aa',
                        borderColor: '#27272a',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8
                    }
                }
            }
        });
        
        return this.instances[canvasId];
    },
    
    createBarChart(canvasId, data, color = '#7c3aed') {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        
        if (this.instances[canvasId]) {
            this.instances[canvasId].destroy();
        }
        
        const ctx = canvas.getContext('2d');
        
        this.instances[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.values,
                    backgroundColor: color + '80',
                    borderColor: color,
                    borderWidth: 1,
                    borderRadius: 4,
                    barThickness: 20
                }]
            },
            options: {
                ...this.defaultOptions,
                plugins: {
                    ...this.defaultOptions.plugins,
                    legend: { display: false }
                },
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: {
                            color: '#52525b',
                            font: { size: 10 }
                        }
                    },
                    y: {
                        ...this.defaultOptions.scales.y,
                        beginAtZero: true
                    }
                }
            }
        });
        
        return this.instances[canvasId];
    },
    
    updateLineChart(canvasId, value) {
        const chart = this.instances[canvasId];
        if (!chart) return;
        
        chart.data.datasets[0].data.shift();
        chart.data.datasets[0].data.push(value);
        chart.update('none');
    },
    
    updateDoughnutChart(canvasId, values) {
        const chart = this.instances[canvasId];
        if (!chart) return;
        
        chart.data.datasets[0].data = values;
        chart.update();
    },
    
    destroy(canvasId) {
        if (this.instances[canvasId]) {
            this.instances[canvasId].destroy();
            delete this.instances[canvasId];
        }
    },
    
    destroyAll() {
        Object.keys(this.instances).forEach(id => this.destroy(id));
    }
};
