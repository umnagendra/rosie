var express         = require('express');
var config          = require('../conf/config.json');
var util            = require('util');
var logger          = require('winston');
var SessionManager  = require('../bot/session-manager');
var conversation    = require('../util/conversation');

logger.level = config.debug ? "debug" : "info";

var router = express.Router();

router.get('/', function (req, res) {
    logger.debug('Received GET request: ' + util.inspect(req.query, false, null));
    if (req.query['hub.verify_token'] === config.fbWebhookToken) {
        res.send(req.query['hub.challenge']);
    } else {
        logger.error('Wrong validation token [%s] received from facebook. Expected [%s]', req.query['hub.verify_token'], config.fbWebhookToken);
        res.send('Error, wrong validation token');
    }
});

router.post('/', function (req, res) {
    logger.debug('Received POST request: ' + util.inspect(req.body, false, null));
    messaging_events = req.body.entry[0].messaging;
    for (i = 0; i < messaging_events.length; i++) {
        event = req.body.entry[0].messaging[i];
        sender = event.sender.id;
        if (event.message && event.message.text) {
            text = event.message.text;
            logger.info('Incoming message: [%s]', text);

            // check if an existing session exists for this sender
            if (SessionManager.getSession(sender) && SessionManager.getSession().state !== "STARTED") {
                // TODO lookup existing session state, and handle accordingly
            } else {
                // new sender, so create a session
                var thisSession = SessionManager.createSession(sender);
                conversation.welcome(thisSession);
                SessionManager.addMessageToBuffer(thisSession.user.id, text);
                logger.debug(util.inspect(thisSession));
                // start asking him questions
            }
        }
    }
    res.sendStatus(200);
});

module.exports = router;
