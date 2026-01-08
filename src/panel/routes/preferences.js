import { requireAuth } from '../utils/authMiddleware.js';

export function setupPreferencesRoutes(app, db) {
    // =====================
    // USER PREFERENCES
    // =====================

    app.get('/api/preferences', requireAuth, (req, res) => {
        const user = db.findUserById(req.user.id);
        res.json({ preferences: user.preferences || {} });
    });

    app.post('/api/preferences', requireAuth, (req, res) => {
        const { theme, terminalFontSize, defaultView, notifications } = req.body;

        const preferences = {};
        if (theme && ['dark', 'light', 'auto'].includes(theme)) {
            preferences.theme = theme;
        }
        if (terminalFontSize && terminalFontSize >= 10 && terminalFontSize <= 24) {
            preferences.terminalFontSize = terminalFontSize;
        }
        if (defaultView && ['console', 'stats', 'settings'].includes(defaultView)) {
            preferences.defaultView = defaultView;
        }
        if (typeof notifications === 'boolean') {
            preferences.notifications = notifications;
        }

        const user = db.findUserById(req.user.id);
        const updatedPrefs = { ...(user.preferences || {}), ...preferences };

        db.updateUser(req.user.id, { preferences: updatedPrefs });
        res.json({ success: true, preferences: updatedPrefs });
    });
}
