var request         = require('request-promise-native');
var syncRequest     = require('sync-request');
var util            = require('util');
var session         = require('../bot/session');
var config          = require('../conf/config.json');
var logger          = require('winston');
var nodeJose        = require('node-jose');
var conversation    = require('../util/conversation');

// constants
var SPARK_CARE_API_VERSION        = "v1";
var SPARK_CARE_CONTROL_API_URL    = "https://chatc.produs1.ciscoccservice.com/chatc/" + SPARK_CARE_API_VERSION;

logger.level = config.system.debug ? "debug" : "info";

var _constructCreateChatPayload = function(thisSession) {
    var payload = {
        customerIdentity: {
            Context_First_Name: thisSession.user.name,
            Context_Work_Email: thisSession.user.email
        },
        reason: thisSession.user.reason,
        orgId: config.contact_center.spark_care.orgId
    };

    return payload;
};

var _getSparkCareRequestHeaders = function(thisSession) {
    var headers = {
        'Cisco-On-Behalf-Of'    : config.contact_center.spark_care.orgId,
        'Bubble-Origin'         : config.contact_center.spark_care.clientOrigin,
        'Accept'                : 'application/json',
        'Bubble-Authorization'  : thisSession.sparkcare.sessiontoken
    };

    return headers;
};

var _getChatEvents = function(session) {
    logger.debug('GETting chat events from session ID [%s] using mediaURL [%s] ...', session.user.id, session.sparkcare.mediaURL);
    var options = {
        uri: session.sparkcare.mediaURL,
        method: 'GET',
        headers: _getSparkCareRequestHeaders(session),
        json: true
    };
    return request(options);
};

var _processChatEvents = function(thisSession, msgArray) {
    if (! msgArray instanceof Array) {
        throw '{msgArray} is not an Array';
    }
    for(var i = 0; i < msgArray.length; i++) {
        var data = msgArray[i].data;
        if (!data || !data.eventType) {
            continue;
        }
        switch(data.eventType) {
            case 'encryption.encrypt_key':
                thisSession.sparkcare.encryptionKey = data.keyValue;
                thisSession.sparkcare.keyURL = data.keyUrl;
                break;

            case 'participant.info':
                thisSession.state = session.STATES.TALKING;
                break;

            case 'conversation.activity':
                _decryptAndPublishToCustomer(thisSession, data.msg);
                break;

            case 'encryption.decrypt_key':
                thisSession.sparkcare.decryptionKey = data.keyValue;
                thisSession.sparkcare.keyURL = data.keyUrl;
                break;

            default:
                logger.error('Unknown chat event with type [%s] received. Ignoring...', data.eventType);
        }
    }
};

var _postChatMessage = function (thisSession, cipherText) {
    logger.debug('Posting a chat message from customer [%s] to Spark Care as part of org [%s] ...', thisSession.user.name, config.contact_center.spark_care.orgId);
    var data = {
        keyUrl: thisSession.sparkcare.keyURL,
        messages: [cipherText]
    };
    var options = {
        uri: thisSession.sparkcare.mediaURL,
        method: 'POST',
        headers: _getSparkCareRequestHeaders(thisSession),
        body: data,
        json: true
    };
    return request(options);
};

var _decryptAndPublishToCustomer = function(thisSession, cipherText) {
    if (!thisSession.sparkcare.decryptionKey) {
        thisSession.outgoingMessages.buffer.push(cipherText);
        return;
    }
    for (var i = 0; i < thisSession.outgoingMessages.buffer.length; i++) {
        var thisCipherText = thisSession.outgoingMessages.buffer[i];
        logger.debug('Decrypting buffered outgoing message [%s] using decryption key [%s]', thisCipherText, thisSession.sparkcare.decryptionKey);
        _decrypt(thisSession.sparkcare.decryptionKey, thisCipherText)
                .then(function(plainTextMsg) {
                    logger.debug('Decrypted plaintext message is [%s]', plainTextMsg);
                    conversation.sendTextMessage(thisSession, plainTextMsg);
                });
    }
    // empty the buffer
    thisSession.outgoingMessages.buffer.length = 0;

    logger.debug('Decrypting message [%s] using decryption key [%s]', cipherText, thisSession.sparkcare.decryptionKey);
    _decrypt(thisSession.sparkcare.decryptionKey, cipherText)
        .then(function(plainTextMsg) {
            logger.debug('Decrypted plaintext message is [%s]', plainTextMsg);
            conversation.sendTextMessage(thisSession, plainTextMsg);
        });
};

var _encrypt = function(key, plainText) {
    var options = {
        compact: true,
        contentAlg: 'A256GCM',
        protect: '*'
    };
    var keyObj = {
        kty: 'oct',
        k: key
    };

    return new Promise(function(resolve, reject) {
        nodeJose.JWK.asKey(keyObj)
            .then(function(joseJWSKey) {
                var encryptKey = {
                    key: joseJWSKey,
                    header: {
                        alg: 'dir'
                    },
                    reference: null
                };
                return encryptKey;
            }).then(function(encryptKey) {
                return nodeJose.JWE.createEncrypt(options, encryptKey).final(plainText, 'utf8');
            }).then(function(cipherText) {
                return resolve(cipherText);
            }).catch(function(error) {
                return reject(error);
            });
    });
};

var _decrypt = function(key, cipherText) {
    var keyObj = {
        kty: 'oct',
        k: key,
        alg: 'dir'
    };

    return nodeJose.JWK.asKey(keyObj)
        .then(function(joseJWSKey) {
            return nodeJose.JWE.createDecrypt(joseJWSKey).decrypt(cipherText);
        }).then(function(result) {
            return result.plaintext.toString();
        });
};

var sparkCareClient = {};

sparkCareClient.getSessionAuthorization = function() {
    logger.info('Asking for authorization from Spark Care for orgId [%s] from client origin [%s] ...', config.contact_center.spark_care.orgId, config.contact_center.spark_care.clientOrigin);
    var options = {
        uri: SPARK_CARE_CONTROL_API_URL + "/chat/session",
        method: 'POST',
        headers: {
            'Cisco-On-Behalf-Of' : config.contact_center.spark_care.orgId,
            'Bubble-Origin' : config.contact_center.spark_care.clientOrigin,
            'Accept' : 'application/json',
        },
        json: true,
        resolveWithFullResponse: true
    };
    return request(options);
};

sparkCareClient.createChat = function(thisSession) {
    logger.info('Creating a chat from customer [%s] to Spark Care as part of org [%s] ...', thisSession.user.name, config.contact_center.spark_care.orgId);
    var data = _constructCreateChatPayload(thisSession);
    var options = {
        uri: SPARK_CARE_CONTROL_API_URL + '/chat',
        method: 'POST',
        headers: _getSparkCareRequestHeaders(thisSession),
        body: data,
        json: true
    };
    return request(options);
};

sparkCareClient.pollForChatEvents = function(thisSession) {
    _getChatEvents(thisSession)
        .then(function(response) {
            logger.debug('Response from polling chat events: ' + util.inspect(response));
            _processChatEvents(thisSession, response.messages);
        })
        .catch(function(error) {
            logger.error('Error polling for chat events:' + error);
            sessionManager.abortSession(thisSession.user.id);
        });
};

sparkCareClient.encryptAndPushToContactCenter = function(thisSession, plainText) {
    // first, encrypt and push all incoming messages held in the buffer
    for (var i = 0; i < thisSession.incomingMessages.buffer.length; i++) {
        var thisPlainText = thisSession.incomingMessages.buffer[i];
        logger.debug('Encrypting buffered incoming message [%s] using encryption key [%s]', thisPlainText, thisSession.sparkcare.encryptionKey);
        _encrypt(thisSession.sparkcare.encryptionKey, thisPlainText)
            .then(function(cipherTextMsg) {
                logger.debug('Encrypted ciphertext message is [%s]', cipherTextMsg);
                _postChatMessage(thisSession, cipherTextMsg)
                    .then(function(){});
            });
    }

    // empty the buffer
    thisSession.incomingMessages.buffer.length = 0;

    _encrypt(thisSession.sparkcare.encryptionKey, plainText)
        .then(function(cipherTextMsg) {
            logger.debug('Encrypted ciphertext message is [%s]', cipherTextMsg);
            _postChatMessage(thisSession, cipherTextMsg)
                .then(function(){});
         });
};

sparkCareClient.getAgentStats = function() {
    logger.debug('GETting agent stats from spark care ...');
    var response = syncRequest('GET', SPARK_CARE_CONTROL_API_URL + '/agentstats/' + config.contact_center.spark_care.orgId);
    var agentStats = JSON.parse(response.getBody('utf8'));
    return agentStats;
};

sparkCareClient.createCallback = function(thisSession) {
    logger.info('Creating a callback from customer [%s] to Spark Care as part of org [%s] ...', thisSession.user.name, config.contact_center.spark_care.orgId);
    var data = {
        customerIdentity: {
            Context_Mobile_Phone: thisSession.user.phone
        },
        orgId: config.contact_center.spark_care.orgId
    };
    var options = {
        uri: SPARK_CARE_CONTROL_API_URL + '/callback',
        method: 'POST',
        headers: _getSparkCareRequestHeaders(thisSession),
        body: data,
        json: true
    };
    return request(options);
};

module.exports = sparkCareClient;
