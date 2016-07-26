var config = require('config'),
    request = require('request');

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

var graph = {
  /*
    Output messages according to selected question
   * Call the Send API. The message data goes in the body. If successful, we'll 
   * get the message id in a response 
   *
   */
  callSendAPI: function callSendAPI(messageData) {
console.log('inside of graph.callSendAPI');

      request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: { access_token: PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: messageData

      }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
          var recipientId = body.recipient_id;
          var messageId = body.message_id;

          console.log("Successfully sent generic message with id %s to recipient %s", 
            messageId, recipientId);
        } else {

          console.error("Unable to send message.");
          // console.error(response);
          console.error(error);
          console.log(messageData);
        }
      });  
    },
  sendTypingIndicator: function(senderID){
console.log('inside of graph.sendTypingIndicator');

    var typingPayload = { recipient: {
          id: senderID
        },
        sender_action: "typing_on"
      };

    request({
      url: "https://graph.facebook.com/v2.6/me/messages?access_token=" + PAGE_ACCESS_TOKEN,
      method: "POST",
      json: true,
      body: typingPayload
    }, function(err, resp, body){
      // silence is golden
    });
  }

}

module.exports = graph;