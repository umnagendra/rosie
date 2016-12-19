const STATES = {
    "STARTED"     : "STARTED",
    "WELCOMED"    : "WELCOMED",
    "INFO"        : "INFO",
    "WAITING"     : "WAITING",
    "TALKING"     : "TALKING",
    "ENDED"       : "ENDED"
};

Session = function(id) {
    this.user = {};
    this.sparkcare = {};
    this.incomingMessages = {};
    this.incomingMessages.buffer = [];
    this.incomingMessages.latestTimestamp = null;
    this.user.id = id;
    this.user.name = "Facebook User" + "." + id;
    this.sparkcare.sessiontoken = null;
    this.state = STATES.STARTED;
}

module.exports = {
    session : Session,
    STATES : STATES
};
