function MessageList()
{
	this.friendly_name = '';
	this.recipient_user_id = '';
	this.recipient_public_key = '';
	this.last_public_key_retrieval = '2017-01-01';
	this.message_group_id = '1';
	this.messages = [];
	this.is_group = false;

	this.toJSON = function()
	{
		return JSON.stringify({
			friendly_name: this.friendly_name,
			recipient_user_id: this.recipient_user_id,
			recipient_public_key: this.recipient_public_key,
			message_group_id: this.message_group_id,
			last_public_key_retrieval: this.last_public_key_retrieval,
			is_group: this.is_group
		});
	};

	this.fromJSONString = function(json_string)
	{
		if (_.isEmpty(json_string)) {
			return;
		}
		const data = JSON.parse(json_string);
		this.friendly_name = data.friendly_name;
		this.recipient_user_id = data.recipient_user_id;
		this.recipient_public_key = data.recipient_public_key;
		this.message_group_id = data.message_group_id;
		this.last_public_key_retrieval = data.last_public_key_retrieval;
		this.is_group = data.is_group;
	};
}

MessageList.prototype.getRecipientPublicKey = async function()
{
	logger.info('calling getRecipientPublicKey');

	if (_.isEmpty(this.recipient_user_id)) {
		logger.error('recipient username is blank');
		return false;
	}

	const response = await current_user.callLambda({
		FunctionName : 'Clinicoin-getPublicKey',
		InvocationType : 'RequestResponse',
		Payload: JSON.stringify({username: this.recipient_user_id}),
		LogType : 'None'
	});

	if ( ! _.isEmpty(response.body) && response.statusCode===200) {
		this.recipient_public_key = response.body.PublicKey.S;
		this.last_public_key_retrieval = moment().format('YYYY-MM-DD HH:mm:ss');
		return response.statusCode === 200;
	}
	else if (response.statusCode===404){
		this.last_error_message = 'Key retrieved failed - '+response.body;
		this.last_error_code = "UserNotFound";
	}
	else if (response.statusCode===400){
		this.last_error_message = 'Key retrieved failed - '+response.body;
		this.last_error_code = "LambdaRetrievalError";
	}
	else {
		this.last_error_message = 'Key retrieved failed - '+current_user.last_error_message;
		this.last_error_code = current_user.last_error_code;
	}

	return false;
};

MessageList.prototype.sendToServer = async function(data, message_type)
{
	if (_.isEmpty(data)) {
		logger.error('nothing to send');
		return false;
	}

	if (_.isEmpty(this.recipient_user_id)) {
		logger.error('no destination user');
		return false;
	}

	const s3 = new AWS.S3({apiVersion: '2006-03-01'});

	if (_.isEmpty(message_type)) {
		message_type = 'msg';
	}

	const key = this.recipient_user_id+'/'+message_type+'_'+moment().format('x')+(_.random(100, 999).toString());

	const params = {
		Body: data,
		Bucket: 'clinicoin-users',
		Key: key,
		Expires: moment().add(30, 'days').unix()
	};

	const send_promise = new Promise((resolve) => {
		s3.putObject(params, function(error, data) {
			if (error) {
				resolve({error:error});
			} else {
				resolve({data:data});
			}
		});
	});

	const result = await send_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('message send success');
		return true;
	}
};

MessageList.prototype.sendMessage = async function(message_data)
{
	let msg = new Message();
	msg.Body = message_data;
	msg.Sender = current_user.username;
	msg.Receiver = this.recipient_user_id;

	this.messages.push(msg);

	// get the recipient's public key if more than 24 hours old
	if (moment(this.last_public_key_retrieval).isBefore(moment().subtract(24, 'hours'))) {
		let key_result = await this.getRecipientPublicKey();
		if (!key_result) {
			logger.info('Key retrieval failure');
			return msg;
		}
	}

	// encrypt the message, sending signed by current
	let signPrivateKeyObj = openpgp.key.readArmored(current_user.getPrivateKey()).keys[0];
	signPrivateKeyObj.decrypt(current_user.getPassphrase());

	await msg.encryptMessage(this.recipient_public_key, [ signPrivateKeyObj ]);

	// send it to the server
	const send_success = await this.sendToServer(msg.EncryptedBody);

	if (!send_success) {
		return msg;
	}

	// save to list
	await this.saveMessage(msg);

	msg.SendStatus = 'Sent';

	return msg;
};

MessageList.prototype.removeAllMessages = async function()
{
	const exp = new RegExp('^ch_'+current_user.username+'_'+this.recipient_user_id+'_[a-f0-9]+', 'i');
	await store.removeItemsExpression(exp);
};

MessageList.prototype.loadMessages = async function()
{
	logger.info('loading messages');

	const self = this;
	this.messages = [];
	const exp = new RegExp('^ch_'+current_user.username+'_'+this.recipient_user_id+'_[a-f0-9]+', 'i');
	const key_list = await store.getFilteredData(exp);
	key_list.forEach(async function(json) {
		const msg = new Message();
		msg.fromJSONString(json);
		logger.debug("loading msg "+msg.MessageId);
	 	self.messages.push(msg);
	});

	self.messages = _.sortBy(self.messages, ['MessageId']);

	return true;
};

MessageList.prototype.saveMessage = async function(msg)
{
	logger.info('save message '+msg.MessageId);
	const json = msg.toJSON();  // converting first allows the dates to be set properly
	await store.setItem('ch_' +current_user.username+'_'+ this.recipient_user_id + '_' + msg.MessageId, json);
	return true;
};

MessageList.prototype.loadSettings = async function()
{
	const settings = await store.getItem('ch_'+current_user.username+'_'+this.recipient_user_id+'_Settings');
	this.fromJSONString(settings);
	return true;
};

MessageList.prototype.saveSettings = async function()
{
	await store.setItem('ch_'+current_user.username+'_'+this.recipient_user_id+'_Settings', this.toJSON());
	return true;
};

MessageList.prototype.removeSettings = async function()
{
	await store.removeItem('ch_'+current_user.username+'_'+this.recipient_user_id+'_Settings');
	return true;
};

MessageList.prototype.markRead = function()
{
	this.messages.forEach((msg)=> {
		if ( ! msg.isRead()) {
			msg.ReadDate = moment({});
			this.saveMessage(msg);
		}
	});
};

MessageList.prototype.processMessage = async function(msg)
{
	this.messages.push(msg);

	// only check for signing if we have key
	let verified = null;
	if (!_.isEmpty(this.recipient_public_key)) {
		let options = {
			message: openpgp.cleartext.readArmored(msg.EncryptedBody), // parse armored message
			publicKeys: openpgp.key.readArmored(this.recipient_public_key).keys   // for verification
		};
		verified = await openpgp.verify(options);

		if (verified.signatures.length > 0 && verified.signatures[0].valid) {
			logger.info("valid signature");
			msg.Signed = true;
		}
	}

	await this.saveMessage(this);
};