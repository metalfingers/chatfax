/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  graph = require('./app/graph-api.js'),
  request = require('request'),
  utterances = require('./app/utterances.js'),
  userSetup = require('./app/user-setup.js');

var mongodb = require("mongodb");
var ObjectID = mongodb.ObjectID;

var app = express();

app.set('port', process.env.PORT || 5000);
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

// var pusher = require("pusher-js");

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN)) {
  console.error("Missing config values");
  process.exit(1);
}

// Create a database variable outside of the database connection callback to reuse the connection pool in your app.
var db;

// Connect to the database before starting the application server.
function dbConnect(){
  mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    db = database;
    dbEvents(db);

    console.log("Database connection ready");
  });


}

function dbEvents(database){
  database.on('close', function () {
    console.log('Error...close');
  });
  database.on('error', function (err) {
    console.log('Error...error', err);
  });
  database.on('disconnect', function (err) {
    console.log('Error...disconnect', err);
  });
  database.on('disconnected', function (err) {
    console.log('Error...disconnected', err);
  });
  database.on('parseError', function (err) {
    console.log('Error...parse', err);
  });
  database.on('timeout', function (err) {
    console.log('Error...timeout', err);

    // attempt to reconnect
    dbConnect();
    
  });
}


dbConnect();

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/implementation#subscribe_app_pages
 *
 */
app.post('/webhook', function (req, res) {

  var data = req.body;

  console.log(JSON.stringify(data));
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event and send the getUserPromise promise and the event
      pageEntry.messaging.forEach(function(messagingEvent) {
        var senderID = messagingEvent.sender.id;
        var recipientID = messagingEvent.recipient.id;
        
        // create getUserPromise to pass to other functions
        var getUserPromise = new Promise (
          function (resolve, reject) {
            userSetup.getUser(db, senderID, resolve, reject);
          }
        );

        getUserPromise.catch(
          function(err) {
            console.log('in /webhook --> getUserPromise reject');
            console.log(err);
            console.log(err.stack);
            if (err.messages) {
              processMessageText();
            }
          });

        if (messagingEvent.optin) {
          receivedAuthentication(getUserPromise, messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(getUserPromise, messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(getUserPromise, messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(getUserPromise, messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  console.log("inside of verifyRequestSignature");
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference#auth
 *
 */
function receivedAuthentication(userPromise, event) {
  console.log("inside of receivedAuthentication");
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = 'event.optin.ref';

  processMessageText();
}


/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference#received_message
 *
 */
function receivedMessage(userPromise, event) {
  console.log("inside of receivedMessage");
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var message = event.message;

  userPromise.then(
    function(userObj) {
      if (userObj.isSetup === false) {          
        // if we're still in setup, continue through that flow
        registerUser(userObj, event);
      } else if (message.text) {
        // we got a text message, go through that function
        processMessageText(userObj, event.message.text, senderID);
      } else if (message.attachments) {
        processAttachment(userObj, event.message);
      } 
    }
  )
  .catch(
    function(err) {
      console.log('in receivedMessage --> userPromise reject');
      console.log(err);
      console.log(err.stack);
      if (err.messages) {
        processMessageText();
      }
    }
  );

}


function registerUser(userObj, event) {
  console.log("inside of registerUser");

  var pendingPromises = [],// an array that will hold all pending promises
      userReply = (event.message ? event.message.text : undefined || event.postback ? event.postback.payload : undefined); 

  // get message text or attachment and save it to the pref slot for the questions just asked
  if (userObj.questionAsked !== null && userReply) {
    // special cases first
    if (userObj.questionAsked === 'homeAddress' || userObj.questionAsked === 'workAddress') {
      var addressToLatLong = new Promise(function(res, rej){
        getStation.byAddress(userReply, res, rej);
      });
      
      pendingPromises.push(addressToLatLong); // save this into the pendingPromises array

      addressToLatLong.then(function(data){

        if (data.results.length === 0) {
          userObj.prefs[userObj.questionAsked] = undefined;
          sendTextMessage(userObj.user_id, "I couldn't find that address.");
        } else if (data.results.length === 1) {
          userObj.prefs[userObj.questionAsked] = {
            lat: data.results[0].geometry.location.lat,
            lon: data.results[0].geometry.location.lng
          };
        } else if (data.results.length > 1) {
          var elementsArray = [],
              messageData;

          userObj.prefs[userObj.questionAsked] = undefined;

          data.results.forEach(function(elem, index){
            var tempObj = {
                    title: elem.formatted_address,
                    image_url: "https://maps.googleapis.com/maps/api/staticmap?center=" + elem.geometry.location.lat + "," + elem.geometry.location.lng + "&zoom=15&size=400x400&&markers=color:red%7Clabel:S%7C" + elem.geometry.location.lat + "," + elem.geometry.location.lng + "&key=" + config.get("googleAPIKey"),
                    buttons: [
                      {
                        type: "postback",
                        title: "Select address",
                        payload: elem.formatted_address
                      }
                    ]
              };

              elementsArray.push(tempObj);
          });        

          messageData = {
            recipient: {
              id: userObj.user_id
            },
            message: {
              attachment: {
                type: "template",
                payload: {
                  template_type: "generic",
                  elements: elementsArray
                }
              }
            }
          };

          graph.callSendAPI(messageData);

        }
      })
      .catch(
        function(err) {
          console.log('in registerUser --> addressToLatLong reject');
          console.log(err);
          console.log(err.stack);
        });
    } else {
      userObj.prefs[userObj.questionAsked] = userReply;
    }
  } else if (userObj.questionAsked !== null && event.message.attachments){
    if(userObj.questionAsked === 'homeAddress' || userObj.questionAsked === 'workAddress') {
      if (event.message.attachments[0].type === 'location') {
        userObj.prefs[userObj.questionAsked] = { lat: event.message.attachments[0].payload.coordinates.lat, lon: event.message.attachments[0].payload.coordinates.long }
      }
    }
  }

  // once all of our pendingPromises are resolved, ask the next 
  // question and save our updated userObj
  Promise.all(pendingPromises).then(function(val){

    // loop through the following to get preliminary user data
    // homeAddress, workAddress, morningAlertTime, eveningAlertTime
    if (!userObj.prefs.homeAddress) {
      userObj.questionAsked = 'homeAddress';
      sendTextMessage(userObj.user_id, "Let's get set up, " + userObj.firstName + ". What's your home address?");
    } else if (!userObj.prefs.workAddress) {
      userObj.questionAsked = 'workAddress';
      sendTextMessage(userObj.user_id, "Got it. What's your work address?");
    } else 
    if (!userObj.prefs.morningAlertTime) {
      userObj.questionAsked = 'morningAlertTime';
      sendTextMessage(userObj.user_id, "Cool. What time do you want a status update in the morning?");  
    } else if (!userObj.prefs.eveningAlertTime) {
      userObj.questionAsked = 'eveningAlertTime';
      sendTextMessage(userObj.user_id, "OK. What time do you want a status update in the evening?");       
    } else {
      // we're set up
      userObj.questionAsked = undefined;
      userObj.isSetup = true;
      sendTextMessage(userObj.user_id, "All set. You can say things like: " + 
                                        "\n  - bikes at work " +
                                        "\n  - bikes at home" +
                                        "\n  - bikes near <address or landmark>" +
                                        "\n  - settings" +
                                        "\n  - notifications" +
                                        "\n  - help");

    }

    userSetup.updateUser(db, userObj.user_id, userObj);

  });
}

function processMessageText (user, messageText, senderID) {
  console.log("inside of processMessageText");
  var messageData; 

    if (!user) {
      
    } else {

      // send the user the typing indicator before we do anything else
      graph.sendTypingIndicator(senderID);

      if (messageText.toLowerCase() ==='station information' ) {
        postStationInfo(senderID);
      } else if (messageText.toLowerCase() === 'bikes at work') {
        messageData = stationStatusMessage(user.prefs.workAddress.lat, user.prefs.workAddress.lon, senderID);
        messageData.then( function(data){
          graph.callSendAPI(data); 
        });
      } else if (messageText.toLowerCase() === 'bikes at home') {
        messageData = stationStatusMessage(user.prefs.homeAddress.lat, user.prefs.homeAddress.lon, senderID);
        messageData.then( function(data){
          graph.callSendAPI(data); 
        });
      } else if (messageText.toLowerCase().match(/bikes near (.*)/) ||
                  messageText.toLowerCase().match(/stations near (.*)/)) {

        var requestedAddress = new Promise(function(res, rej) {
          getStation.byAddress( messageText.toLowerCase().match(/bikes near (.*)/)[1], res, rej );
        });

        requestedAddress.then(function(data){
          messageData = stationStatusMessage(data.results[0].geometry.location.lat, data.results[0].geometry.location.lng, senderID);
          messageData.then( function(data){
            graph.callSendAPI(data); 
          });
        });

      } else if (messageText.toLowerCase() === 'notifications') {
        // notifications(senderID, 'a few notifications');
      } else if (messageText.toLowerCase() === 'settings' ||
                 messageText.toLowerCase() === 'change settings') {
          // updateSettings(senderID);
      } else if (messageText.toLowerCase() === 'help' ||
                 messageText.toLowerCase() === 'stop notifications') {
          // help(senderID, messageText);
      } else {
          sendTextMessage(senderID, "I don't understand what you mean. Type \"help\" for a list of commands.");
      }

    }

}

/*
 * Message with Attachment
 *
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 */
function processAttachment(userObj, message) {
  console.log("inside of processAttachment");
  var messageData;
  
console.log('attachment message:', JSON.stringify(message));

  // send the user the typing indicator before we do anything else
  graph.sendTypingIndicator(userObj.user_id);

  // do things with different attachment types
  if (message.attachments[0].type === 'location') {
    messageData = stationStatusMessage(message.attachments[0].payload.coordinates.lat, message.attachments[0].payload.coordinates.long, userObj.user_id);
    messageData.then( function(data){
      graph.callSendAPI(data); 
    });
  }  else if ( message.attachments[0].type === 'image' ) {
    if (message.sticker_id) {
      sendTextMessage(userObj.user_id, "Cute sticker, but I can't do anything with it yet.");
    } else {
      sendTextMessage(userObj.user_id, "Sorry, I can't do anything with an image yet.");      
    }
  } else if ( message.attachments[0].type === 'audio' ) {
    sendTextMessage(userObj.user_id, "Sorry, I can't do anything with audio yet.");
  } else if ( message.attachments[0].type === 'video' ) {
    sendTextMessage(userObj.user_id, "Sorry, I can't do anything with video yet.");
  } else if ( message.attachments[0].type === 'file' ) {
    sendTextMessage(userObj.user_id, "Sorry, I can't do anything with files yet.");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference#message_delivery
 *
 */
function receivedDeliveryConfirmation(userPromise, event) {
  console.log("inside of receivedDeliveryConfirmation");
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. Read
 * more at https://developers.facebook.com/docs/messenger-platform/webhook-reference#postback
 * 
 */
function receivedPostback(userPromise, event) {
  console.log("inside of receivedPostback");
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;
  
  userPromise.then(
    function(userObj){
      if (userObj.isSetup === false) {
          registerUser(userObj, event);
      }
    }
  );
}


/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  console.log("inside of sendTextMessage");
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  graph.callSendAPI(messageData);
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});




module.exports = app;

