import crypto from 'node:crypto';
import { requireAuth } from '../utils/authMiddleware.js';
import { log } from '../utils/logger.js';

export const WEBHOOK_EVENTS = ['vm_start', 'vm_stop', 'vm_create', 'vm_delete', 'alert_triggered'];

export async function triggerWebhooks(db, event, data) {
    const webhooks = db.getWebhooksByEvent(event);

    for (const webhook of webhooks) {
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            data
        };

        const headers = {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Webhook-Timestamp': payload.timestamp,
            'User-Agent': 'v87-webhook/1.0'
        };

        if (webhook.secret) {
            const signature = crypto
                .createHmac('sha256', webhook.secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            headers['X-Webhook-Signature'] = `sha256=${signature}`;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(webhook.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (response.ok) {
                log(`Webhook ${webhook.id} delivered: ${event} -> ${webhook.url}`);
            } else {
                log(`Webhook ${webhook.id} failed: ${response.status} ${response.statusText}`);
            }
        } catch (err) {
            log(`Webhook ${webhook.id} error: ${err.message}`);
        }
    }
}

export async function testWebhook(webhook) {
    const payload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test webhook from v87' }
    };

    const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'test',
        'X-Webhook-Timestamp': payload.timestamp,
        'User-Agent': 'v87-webhook/1.0'
    };

    if (webhook.secret) {
        const signature = crypto
            .createHmac('sha256', webhook.secret)
            .update(JSON.stringify(payload))
            .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(webhook.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeout);

        return {
            success: response.ok,
            status: response.status,
            statusText: response.statusText
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            success: false,
            error: err.message
        };
    }
}

export function setupWebhooksRoutes(app, db, audit) {
    // =====================
    // WEBHOOKS
    // =====================

    app.get('/api/webhooks', requireAuth, (req, res) => {
        const webhooks = db.getWebhooks(req.user.id).map(w => ({
            ...w,
            secret: w.secret ? '••••••••' : null
        }));
        res.json({ webhooks, availableEvents: WEBHOOK_EVENTS });
    });

    app.post('/api/webhooks', requireAuth, (req, res) => {
        const { name, url, events, secret } = req.body;

        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const userWebhooks = db.getWebhooks(req.user.id);
        if (userWebhooks.length >= 5) {
            return res.status(400).json({ error: 'Maximum 5 webhooks allowed' });
        }

        const validEvents = (events || []).filter(e => WEBHOOK_EVENTS.includes(e));
        if (validEvents.length === 0) {
            return res.status(400).json({ error: 'At least one valid event required' });
        }

        const webhook = {
            id: Date.now().toString(),
            userId: req.user.id,
            name: name || 'Webhook',
            url,
            events: validEvents,
            secret: secret || null,
            enabled: true,
            createdAt: new Date().toISOString()
        };

        db.createWebhook(webhook);
        audit(req.user.id, req.user.username, 'webhook_created', { webhookId: webhook.id });
        res.json({ success: true, webhook: { ...webhook, secret: webhook.secret ? '••••••••' : null } });
    });

    app.put('/api/webhooks/:id', requireAuth, (req, res) => {
        const { name, url, events, secret, enabled } = req.body;

        const updates = {};
        if (name) updates.name = name;
        if (url && url.startsWith('http')) updates.url = url;
        if (events) updates.events = events.filter(e => WEBHOOK_EVENTS.includes(e));
        if (secret !== undefined) updates.secret = secret || null;
        if (typeof enabled === 'boolean') updates.enabled = enabled;

        const updated = db.updateWebhook(req.params.id, req.user.id, updates);
        if (!updated) {
            return res.status(404).json({ error: 'Webhook not found' });
        }

        res.json({ success: true, webhook: { ...updated, secret: updated.secret ? '••••••••' : null } });
    });

    app.delete('/api/webhooks/:id', requireAuth, (req, res) => {
        db.deleteWebhook(req.params.id, req.user.id);
        res.json({ success: true });
    });

    app.post('/api/webhooks/:id/test', requireAuth, async (req, res) => {
        const webhooks = db.getWebhooks(req.user.id);
        const webhook = webhooks.find(w => w.id === req.params.id);

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' });
        }

        const result = await testWebhook(webhook);

        if (result.success) {
            res.json({ success: true, message: `Webhook delivered successfully (${result.status})` });
        } else {
            res.json({ success: false, error: result.error || `Failed with status ${result.status}: ${result.statusText}` });
        }
    });
}
