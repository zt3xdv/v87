import db from '../db.js';

function log(message) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`  \x1b[2m${timestamp}\x1b[0m  \x1b[34m●\x1b[0m  ${message}`);
}

function audit(userId, username, action, details = {}) {
    db.addAuditLog({ userId, username, action, ...details });
}

export function startSchedulers(db, nodeManager, triggerWebhooks) {
    const intervals = [];
    
    // =====================
    // SCHEDULE PROCESSOR - Every minute
    // =====================
    const scheduleProcessor = setInterval(async () => {
        const now = new Date();
        const currentDay = now.getDay();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        const schedules = db.getSchedules();
        
        for (const schedule of schedules) {
            if (!schedule.enabled) continue;
            
            const shouldRun = schedule.days.includes(currentDay) &&
                schedule.hour === currentHour &&
                schedule.minute === currentMinute;
            
            if (!shouldRun) continue;
            
            const lastRun = schedule.lastRun ? new Date(schedule.lastRun) : null;
            if (lastRun && (now - lastRun) < 60000) continue;
            
            const server = db.getServer(schedule.serverId);
            if (!server) {
                db.deleteSchedule(schedule.id);
                continue;
            }
            
            if (!server.nodeId) continue;
            
            const client = nodeManager.getClient(server.nodeId);
            if (!client || !client.isConnected()) continue;
            
            const currentStatus = server.status || 'stopped';
            
            try {
                if (schedule.action === 'start' && currentStatus !== 'running') {
                    await client.startVM(server.id, server.ownerId);
                    db.updateServer(server.id, { status: 'running' });
                    log(`Scheduler: Started VM ${server.name} (${server.id})`);
                    audit('system', 'scheduler', 'scheduled_start', { serverId: server.id, scheduleId: schedule.id });
                } else if (schedule.action === 'stop' && currentStatus === 'running') {
                    await client.stopVM(server.id);
                    db.updateServer(server.id, { status: 'stopped' });
                    log(`Scheduler: Stopped VM ${server.name} (${server.id})`);
                    audit('system', 'scheduler', 'scheduled_stop', { serverId: server.id, scheduleId: schedule.id });
                } else if (schedule.action === 'restart' && currentStatus === 'running') {
                    await client.stopVM(server.id);
                    await new Promise(r => setTimeout(r, 3000));
                    await client.startVM(server.id, server.ownerId);
                    db.updateServer(server.id, { status: 'running' });
                    log(`Scheduler: Restarted VM ${server.name} (${server.id})`);
                    audit('system', 'scheduler', 'scheduled_restart', { serverId: server.id, scheduleId: schedule.id });
                }
                
                db.updateSchedule(schedule.id, { lastRun: now.toISOString() });
            } catch (err) {
                log(`Scheduler error for ${server.id}: ${err.message}`);
            }
        }
    }, 60000);
    intervals.push(scheduleProcessor);
    
    // =====================
    // METRICS COLLECTOR - Every minute
    // =====================
    const metricsCollector = setInterval(async () => {
        const servers = db.getServers().filter(s => s.status === 'running' && s.nodeId);
        
        for (const server of servers) {
            try {
                const client = nodeManager.getClient(server.nodeId);
                if (!client || !client.isConnected()) continue;
                
                const result = await client.getVMStats(server.id);
                if (result && result.stats) {
                    db.addMetric(server.id, {
                        cpu: result.stats.cpuUsage || 0,
                        memoryUsed: result.stats.memory?.actual || 0,
                        memoryTotal: result.stats.memory?.configured || 0,
                        uptime: result.stats.uptime || 0
                    });
                }
            } catch {}
        }
    }, 60000);
    intervals.push(metricsCollector);
    
    // =====================
    // ALERT CHECKER - Every 30 seconds
    // =====================
    const alertChecker = setInterval(async () => {
        const servers = db.getServers();
        
        for (const server of servers) {
            const alerts = db.getServerAlerts(server.id);
            if (alerts.length === 0) continue;
            
            if (!server.nodeId || server.status !== 'running') continue;
            
            const client = nodeManager.getClient(server.nodeId);
            if (!client || !client.isConnected()) continue;
            
            let stats = null;
            try {
                const result = await client.getVMStats(server.id);
                stats = result?.stats;
            } catch {}
            if (!stats) continue;
            
            for (const alert of alerts) {
                let value = 0;
                if (alert.metric === 'cpu') {
                    value = stats.cpuUsage || 0;
                } else if (alert.metric === 'memory' && stats.memory) {
                    value = (stats.memory.actual / stats.memory.configured) * 100;
                }
                
                const shouldTrigger = alert.comparison === 'above' 
                    ? value > alert.threshold 
                    : value < alert.threshold;
                
                if (shouldTrigger && !alert.triggered) {
                    db.updateAlert(alert.id, { triggered: true, lastTriggered: new Date().toISOString() });
                    
                    triggerWebhooks('alert_triggered', {
                        alertId: alert.id,
                        serverId: server.id,
                        serverName: server.name,
                        metric: alert.metric,
                        value,
                        threshold: alert.threshold
                    });
                    
                    audit(alert.userId, 'system', 'alert_triggered', {
                        alertId: alert.id,
                        serverId: server.id,
                        metric: alert.metric,
                        value
                    });
                    
                    if (alert.action === 'stop') {
                        client.stopVM(server.id).catch(() => {});
                        db.updateServer(server.id, { status: 'stopped' });
                    }
                } else if (!shouldTrigger && alert.triggered) {
                    db.updateAlert(alert.id, { triggered: false });
                }
            }
        }
    }, 30000);
    intervals.push(alertChecker);
    
    return {
        stop: () => {
            for (const interval of intervals) {
                clearInterval(interval);
            }
            log('All schedulers stopped');
        }
    };
}
