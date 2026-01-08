import { requireAuth } from '../utils/authMiddleware.js';

export function setupSchedulesRoutes(app, db, audit) {
    // =====================
    // SCHEDULES (Global view)
    // =====================

    app.get('/api/schedules', requireAuth, (req, res) => {
        const schedules = db.getUserSchedules(req.user.id);
        const enriched = schedules.map(s => {
            const server = db.getServer(s.serverId);
            return { ...s, serverName: server?.name || 'Unknown' };
        });
        res.json(enriched);
    });

    app.put('/api/schedules/:id', requireAuth, (req, res) => {
        const { enabled, hour, minute, days } = req.body;

        const schedules = db.getUserSchedules(req.user.id);
        const schedule = schedules.find(s => s.id === req.params.id);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        const updates = {};
        if (typeof enabled === 'boolean') updates.enabled = enabled;
        if (hour !== undefined) updates.hour = parseInt(hour);
        if (minute !== undefined) updates.minute = parseInt(minute);
        if (Array.isArray(days)) updates.days = days.map(d => parseInt(d));

        const updated = db.updateSchedule(req.params.id, updates);
        res.json({ success: true, schedule: updated });
    });

    app.delete('/api/schedules/:id', requireAuth, (req, res) => {
        const schedules = db.getUserSchedules(req.user.id);
        const schedule = schedules.find(s => s.id === req.params.id);
        if (!schedule) {
            return res.status(404).json({ error: 'Schedule not found' });
        }

        db.deleteSchedule(req.params.id);
        res.json({ success: true });
    });
}
