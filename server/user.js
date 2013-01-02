var fs = require('fs'),
    https = require('https');

var constants = require('./constants.js');

function User (nick, conn, obj, room) {
    if (User.has(nick)) {
        throw new Error('There is already a user with the same nick "' + nick + '"');
    }

    this.nick = nick;
    this.conn = conn;
    this.obj = obj;
    this.room = room;
    this.special = User.getSpecialStatus(nick);

    User.users[nick] = this;
    User.userCount++;
    if (User.isModerator(nick)) {
        User.modCount++;
    }
}
User.prototype.sendAccountState = function () {
    this.send({
        type: 'account_state',
        nick: this.nick,
        special: User.getSpecialStatus(this.nick),
        bits: User.hasBits(this.nick),
        inventory: User.getInventory(this.nick),
        friends: User.getFriends(this.nick)
    });
};
User.prototype.kill = function () {
    delete User.users[this.nick];

    User.userCount--;
    if (User.isModerator(this.nick)) {
        User.modCount--;
    }
};
User.prototype.send = function (msg) {
    this.conn.sendUTF(JSON.stringify(msg));
};
User.prototype.kick = function (reason, msg) {
    this.send({
        type: 'kick',
        reason: reason,
        msg: msg
    });
    this.conn.close();
};

User.users = [];
User.userCount = 0;
User.modCount = 0;
User.specialUsers = {};
User.accounts = {};
User.emails = {};
User.bypass = {};

User.init = function () {
    this.specialUsers = JSON.parse(fs.readFileSync('data/special-users.json'));
    console.log('Loaded special users info');
    this.bypass = JSON.parse(fs.readFileSync('data/bypass.json'));
    console.log('Loaded login bypass exceptions');
    try {
        var data1 = fs.readFileSync('data/accounts.json');
        var data2 = fs.readFileSync('data/emails.json');
    } catch (e) {
        console.log('Error loading accounts, skipped');
        return;
    }
    this.accounts = JSON.parse(data1);
    this.emails = JSON.parse(data2);
    console.log('Loaded accounts');
};
User.save = function () {
    fs.writeFileSync('data/accounts.json', JSON.stringify(this.accounts));
    fs.writeFileSync('data/emails.json', JSON.stringify(this.emails));
    console.log('Saved accounts');
};
User.getSpecialStatus = function (nick) {
    if (this.specialUsers.hasOwnProperty(nick)) {
        return this.specialUsers[nick];
    }
    return false;
};
User.isModerator = function (nick) {
    var status = this.getSpecialStatus(nick);
    return (status === 'moderator' || status === 'developer' || status === 'creator' || status === 'bot');
};
User.checkBypass = function (nick, bypass) {
    if (!this.bypass.hasOwnProperty(nick)) {
        return false;
    }
    return (this.bypass[nick] === bypass);
};
User.assert = function (assertion, callback) {
    var postdata;

    if (constants.DEBUG_MODE) {
        postdata = 'assertion=' + assertion + '&audience=' + constants.DEBUG_ORIGIN;
    } else {
        postdata = 'assertion=' + assertion + '&audience=' + constants.DEFAULT_ORIGIN;
    }

    var req = https.request({
        hostname: 'verifier.login.persona.org',
        method: 'POST',
        path: '/verify',
        headers: {
            'Content-Length': postdata.length,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }, function (res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            var data = JSON.parse(chunk);
            if (data.status === 'okay') {
                callback(true, data.email);
                return;
            }
            callback(false);
        });
    });

    req.on('error', function (e) {
        callback(false);
    });

    req.write(postdata);
    req.end();
};
User.createAccount = function (nick, email) {
    if (this.hasAccount(nick)) {
        throw new Error('Account with given nick already exists.');
    }
    if (this.emails.hasOwnProperty(email)) {
        throw new Error('Account with given email already exists.');
    }
    this.accounts[nick] = {
        email: email
    };
    this.emails[email] = nick;
    this.save();
};
User.deleteAccount = function (nick) {
    if (!this.hasAccount(nick)) {
        throw new Error('No account with given nick exists.');
    }
    delete this.emails[this.accounts[nick].email];
    delete this.accounts[nick];
    this.save();
};
User.hasAccount = function (nick) {
    return this.accounts.hasOwnProperty(nick);
};
User.hasEmail = function (email) {
    return this.emails.hasOwnProperty(email);
};
User.getAccountForEmail = function (email) {
    if (this.hasEmail(email)) {
        return User.emails[email];
    }
    return null;
};

User.hasBits = function (nick) {
    if (this.hasAccount(nick)) {
        return this.getUserData(nick, 'bits', 0);
    } else {
        return null;
    }
};
User.getUserData = function (nick, property, defaultValue) {
    if (this.accounts.hasOwnProperty(nick)) {
        if (this.accounts[nick].hasOwnProperty(property)) {
            return this.accounts[nick][property];
        }
    }
    return defaultValue;
};
User.setUserData = function (nick, property, value) {
    if (!this.hasAccount(nick)) {
        throw new Error('There is no account with the given nick.');
    }
    this.accounts[nick][property] = value;
    this.save();
};
User.changeBits = function (nick, amount) {
    if (this.hasAccount(nick)) {
        var bits = this.getUserData(nick, 'bits', 0);

        bits += amount;

        if (bits >= 0 && Number.isFinite(bits) && !Number.isNaN(bits)) {
            this.setUserData(nick, 'bits', bits);

            if (User.has(nick)) {
                User.get(nick).sendAccountState();
            }
            return true;
        }
    }
    return false;
};

User.getUnseenWarnings = function (nick) {
    return this.getUserData(nick, 'warnings', []);
};
User.addWarning = function (nick, mod_nick, mod_special, reason) {
    var warnings = this.getUnseenWarnings(nick);
    warnings.push({
        mod_nick: mod_nick,
        mod_special: mod_special,
        reason: reason
    });
    this.setUserData(nick, 'warnings', warnings);
};
User.clearUnseenWarnings = function (nick, friend) {
    this.setUserData(nick, 'warnings', []);
};

User.getProfile = function (nick) {
    if (!this.hasAccount(nick)) {
        return null;
    }
    var profile = {
        nick: nick,
        online: this.has(nick)
    };
    if (profile.online) {
        profile.room = this.get(nick).room;
    }
    return profile;
};
User.getFriends = function (nick) {
    return this.getUserData(nick, 'friends', []);
};
User.hasFriend = function (nick, friend) {
    return this.getFriends(nick).indexOf(friend) !== -1;
};
User.addFriend = function (nick, friend) {
    var friends = this.getFriends(nick);
    if (friends.indexOf(friend) === -1) {
        friends.push(friend);
    }
    this.setUserData(nick, 'friends', friends);
};
User.removeFriend = function (nick, friend) {
    var friends = this.getFriends(nick);
    var index;
    if ((index = friends.indexOf(friend)) !== -1) {
        friends.splice(index, 1);
    }
    this.setUserData(nick, 'friends', friends);
};

User.getHomeRoom = function (nick) {
    return this.getUserData(nick, 'home_room', null);
};
User.setHomeRoom = function (nick, data) {
    return this.setUserData(nick, 'home_room', data);
};

User.getInventory = function (nick) {
    return this.getUserData(nick, 'inventory', []);
};
User.hasInventoryItem = function (nick, item) {
    return this.getInventory(nick).indexOf(item) !== -1;
};
User.giveInventoryItem = function (nick, item) {
    var inventory = this.getInventory(nick);
    if (inventory.indexOf(item) === -1) {
        inventory.push(item);
    }
    this.setUserData(nick, 'inventory', inventory);
};

User.get = function (nick) {
    if(!this.has(nick)) {
        throw new Error("There is no user named: " + nick);
    }

    return this.users[nick];
};
User.has = function (nick) {
    return this.users.hasOwnProperty(nick);
};
User.forEach = function (callback) {
    for (var nick in this.users) {
        if (this.users.hasOwnProperty(nick)) {
            callback(this.users[nick]);
        }
    }
};

User.init();

module.exports = User;
