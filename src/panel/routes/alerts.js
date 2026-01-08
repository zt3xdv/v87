import { requireAuth } from '../utils/authMiddleware.js';

export function setupAlertsRoutes(app, db, audit) {
    // =====================
    // ALERTS
    // =====================

    app.get('/api/alerts', requireAuth, (req, res) => {
        const alerts = db.getAlerts(req.user.id);
        res.json({ alerts });
    });

    app.post('/api/alerts', requireAuth, (req, res) => {
        const { serverId, metric, threshold, comparison, action } = req.body;

        const server = db.getServer(serverId);
        if (!server || (server.ownerId !== req.user.id && req.user.role !== 'admin')) {
            return res.status(404).json({ error: 'Server not found' });
        }

        if (!['cpu', 'memory'].includes(metric)) {
            return res.status(400).json({ error: 'Invalid metric. Use: cpu, memory' });
        }

        if (!['above', 'below'].includes(comparison)) {
            return res.status(400).json({ error: 'Invalid comparison. Use: above, below' });
        }

        const userAlerts = db.getAlerts(req.user.id);
        if (userAlerts.length >= 10) {
            return res.status(400).json({ error: 'Maximum 10 alerts allowed' });
        }

        const alert = {
            id: Date.now().toString(),
            userId: req.user.id,
            serverId,
            serverName: server.name,
            metric,
            threshold: parseFloat(threshold) || 80,
            comparison,
            action: action || 'notify',
            enabled: true,
            triggered: false,
            lastTriggered: null,
            createdAt: new Date().toISOString()
        };

        db.createAlert(alert);
        audit(req.user.id, req.user.username, 'alert_created', { alertId: alert.id, serverId });
        res.json({ success: true, alert });
    });

    app.put('/api/alerts/:id', requireAuth, (req, res) => {
        const { threshold, enabled } = req.body;

        const alerts = db.getAlerts(req.user.id);
        const alert = alerts.find(a => a.id === req.params.id);
        if (!alert) {
            return res.status(404).json({ error: 'Alert not found' });
        }

        const updates = {};
        if (threshold !== undefined) updates.threshold = parseFloat(threshold);
        if (typeof enabled === 'boolean') updates.enabled = enabled;

        const updated = db.updateAlert(req.params.id, updates);
        res.json({ success: true, alert: updated });
    });

    app.delete('/api/alerts/:id', requireAuth, (req, res) => {
        db.deleteAlert(req.params.id);
        res.json({ success: true });
    });
}
