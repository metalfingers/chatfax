var config = require('config'),
    request = require('request');

var setup = { 
  createUser: function(db, senderID, resolve, reject){
console.log('inside of setup.createUser');

    // save user, start setup flow
    request({
      url: 'https://graph.facebook.com/v2.6/' + senderID,
      qs: {
        fields: 'first_name',
        access_token: config.get('pageAccessToken')
      },
      json: true
    }, function(err, res, body){
      var updateObj = {
                  user_id: senderID,
                  isSetup: false,
                  firstName: body.first_name,
                  questionAsked: null,
                  prefs: {
                    homeAddress: null,
                    workAddress: null,
                    morningAlertTime: null,
                    eveningAlertTime: null
                  }
                };

      setup.updateUser(db, senderID, updateObj, resolve, reject);

    });
  },
	updateUser: function(db, userID, updateObj, resolve, reject){
console.log('inside of setup.updateUser');

		// We have a successful authentication, let's set the user up in the db
    db.collection('users').update({ user_id: userID }, updateObj, { upsert: true },
        function(err, doc) {
            if (err) {
                if (reject) {
                  reject(doc);
                }
            } else {
                console.log(doc.result);
                if (resolve) {
                  setup.getUser(db, userID, resolve, reject);
                }
                return true;
            }
        });
  },
  getUser: function(db, userID, resolve, reject) {
console.log('inside of setup.getUser');

  	db.collection('users').findOne({user_id: userID}, function(err, doc) {
console.log('inside of setup.getUser db callback');
	    if (err) {
	      reject(err);
	    } else if (doc === null) {
        setup.createUser(db, userID, resolve, reject);
      } else {
	      resolve(doc);
      }
	  });
  }
}

module.exports = setup;



