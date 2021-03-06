
class Group extends MessageList
{
	constructor()
	{
		super();

		this.friendly_name = '';
		this.group_name = '';
		this.admin_list = [];
		this.user_list = [];
		this.group_passphrase = '';
		this.group_private_key = '';
		this.group_public_key = '';
		this.group_status = '';
		this.group_type = 'open';
		this.last_error = '';
	}

	toGroupJSON()
	{
		return JSON.stringify({
			friendly_name: this.friendly_name,
			group_name: this.group_name,
			group_passphrase: this.group_passphrase,
			group_private_key: this.group_private_key,
			group_public_key: this.group_public_key,
			group_status: this.group_status,
			group_type: this.group_type,
			is_group: true
		});
	};

	fromGroupJSONString(json_string)
	{
		if (_.isEmpty(json_string)) {
			return;
		}
		const data = JSON.parse(json_string);
		this.group_name = data.group_name;
		this.friendly_name = data.friendly_name;
		if (_.isEmpty(this.friendly_name)) {
			this.friendly_name = this.group_name;
		}
		this.recipient_user_id = data.group_name;
		this.group_passphrase = data.group_passphrase;
		this.group_private_key = data.group_private_key;
		this.group_public_key = data.group_public_key;
		this.group_status = data.group_status;
		this.group_type = data.group_type;
		this.is_group = true;
	};

	async loadSettings()
	{
		const settings = await store.getItem('gr_'+current_user.username+'_'+this.group_name+'_Settings');
		if ( ! _.isEmpty(settings)) {
			this.fromGroupJSONString(settings);
		}

		const admin_json = await store.getItem('gr_'+current_user.username+'_'+this.group_name+'_Admins');
		if ( ! _.isEmpty(admin_json)) {
			this.admin_list = JSON.parse(admin_json);
		}

		const user_json = await store.getItem('gr_'+current_user.username+'_'+this.group_name+'_Users');
		if ( ! _.isEmpty(user_json)) {
			this.user_list = JSON.parse(user_json);
		}

		return true;
	};

	async saveSettings()
	{
		await store.setItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Settings', this.toGroupJSON());

		await store.setItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Admins', JSON.stringify(this.admin_list));

		await store.setItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Users', JSON.stringify(this.user_list));

		return true;
	};

	async removeSettings()
	{
		await store.removeItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Settings');
		await store.removeItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Admins');
		await store.removeItem('gr_'+current_user.username.toLowerCase()+'_'+this.group_name.toLowerCase()+'_Users');
	}

	async processMessage(msg)
	{
		if (_.find(this.messages, { AwsKey: msg.AwsKey }) !== undefined) {
			return;
		}

		// only check for signing if we have key
		await this.verifySignature(msg);

		msg.MessageList = this;
		msg.recipient_user_id = this.group_name;

		if (/(.+)\/msg_(\d+)/i.test(msg.AwsKey)) {
			// regular message, so just push and return
			this.messages.push(msg);
		}
		else {

			if (_.startsWith(msg.Body, '-----BEGIN PGP MESSAGE')) {
				const internal_msg = new Message();
				internal_msg.EncryptedBody = msg.Body;

				let private_key_obj = openpgp.key.readArmored(this.group_private_key).keys[0];
				private_key_obj.decrypt(this.group_passphrase);

				await internal_msg.decryptMessage(channels, private_key_obj);

				msg.deleteFromServer();
				return;
			}


			let data = '';
			try {
				data = JSON.parse(msg.Body);
			} catch (e) {
				logger.error('failure parsing json, removing from server');
				msg.deleteFromServer();
			}

			if (data.command === 'join_request ' + this.group_name && this.group_type === 'open') {
				// auto-process for an open group
				await this.adminApproveJoin(msg.Sender);
				msg.deleteFromServer();

				msg.Command = {
					request: 'join_auto_approved',
					group: this.group_name,
					sender: this.recipient_user_id
				};

				this.messages.push(msg);
			}
			else if (data.command === 'join_request ' + this.group_name && this.isAdmin()) {
				// user requested to join closed group
				msg.Body = 'Command';
				msg.Command = {
					request: 'join',
					group: this.group_name,
					sender: this.recipient_user_id
				};

				this.messages.push(msg);
			}
			else if (data.command === 'join_approved') {
				// approval received by the requesting user
				await this.userJoinApprovalEvent(msg);

				msg.Body = 'Join Approved';
				msg.Command = {
					request: 'join_approved',
					group: this.group_name,
					sender: this.recipient_user_id
				};

				this.messages.push(msg);
			}
			else if (data.command === 'join_notify' && msg.Signed) {
				this.user_list.push(msg.Sender);
				this.user_list = _.uniq(this.user_list);

				msg.Body = 'Command';
				msg.Command = {
					request: 'join_notify',
					group: this.group_name,
					sender: this.recipient_user_id
				};
				this.messages.push(msg);
			}
			else if (data.command === 'promote' && msg.Signed) {
				this.adminPromoteEvent(msg.Sender);

				msg.Body = 'Command';
				msg.Command = {
					request: 'promote',
					group: this.group_name,
					sender: this.recipient_user_id
				};
				this.messages.push(msg);
			}
			else if (data.command === 'demote' && msg.Signed) {
				this.adminDemoteEvent(msg.Sender);

				msg.Body = 'Command';
				msg.Command = {
					request: 'demote',
					group: this.group_name,
					sender: this.recipient_user_id
				};
				this.messages.push(msg);
			}
			else if (data.command === 'left' && msg.Signed) {
				msg.Body = 'Command';
				msg.Command = {
					request: 'left',
					group: this.group_name,
					sender: this.recipient_user_id
				};
				this.messages.push(msg);
			}
			else if (data.command === 'new_group_key' && msg.Signed) {
				this.newKeyEvent(msg);

				msg.Body = 'Command';
				msg.Command = {
					request: 'new_key',
					group: this.group_name,
					sender: this.recipient_user_id
				};
				this.messages.push(msg);
			}
		}

		this.saveMessage(msg);

		if (channels.newMessageEventDelegate != null && typeof channels.newMessageEventDelegate === "function") {
			msg.MessageList.recipient_user_id = this.group_name.toLowerCase();
			channels.newMessageEventDelegate(msg);
		}
	};

	async verifySignature(msg)
	{
		let verified = null;
		try {
			if (_.indexOf(this.admin_list, msg.Sender) > -1) {
				let admin_public = await this.getAdminKey(msg.Sender);

				let options = {
					message: openpgp.cleartext.readArmored(msg.RawBody),
					publicKeys: openpgp.key.readArmored(admin_public).keys
				};
				verified = await openpgp.verify(options);

				if (verified.signatures.length > 0 && verified.signatures[0].valid) {
					logger.info("valid signature");
					msg.Signed = true;
				}
				else {
					logger.debug("signature not validated")
				}
			}
		}
		catch (e) {
			logger.warn('could not verify signature');
		}

		this.recipient_public_key = this.group_public_key;
	}

	isAdmin()
	{
		return _.indexOf(this.admin_list, current_user.username) > -1;
	}

	static async createGroup(group_name, group_type)
	{
		logger.info('calling createGroup');

		if (_.isEmpty(group_name) || _.isEmpty(group_name.trim())) {
			logger.error("group name is empty");
			return "group name is empty";
		}

		if (group_name.replace(/\W+/ig, "") !== group_name) {
			logger.error('group name contains spaces or special characters');
			return 'group name contains spaces or special characters';
		}

		if (channels.findByUsername(group_name)) {
			logger.error('group name exists locally');
			return 'group name exists locally';
		}

		// check if the group already exists
		let group = new Group();
		group.group_name = group_name.toLowerCase();
		group.friendly_name = group_name;
		group.recipient_user_id = group_name.toLowerCase();
		group.group_type = group_type.toLowerCase();
		const exists = await group.getRecipientPublicKey();

		if (exists) {
			logger.error("group with that name already exists");
			return "group with that name already exists";
		}

		// good to go, create keys and save
		await group.generateGroupKey();

		const result = await group.updateGroupPublicKey();

		if (result.statusCode !== 200) {
			logger.error("Unknown error setting public key");
			return "Unknown error setting public key";
		}

		group.admin_list.push(current_user.username);

		group.saveSettings();

		channels.addGroupChannel(group);

		return group;
	};

	static randomPassword(length) {
		const chars = "abcdefghijklmnopqrstuvwxyz!@#$%^&*()-+<>ABCDEFGHIJKLMNOP1234567890";
		let pass = "";
		for (let x = 0; x < length; x++) {
			let i = Math.floor(Math.random() * chars.length);
			pass += chars.charAt(i);
		}
		return pass;
	}

	async getGroupKey()
	{
		logger.info('calling joinGroup');

		if (_.isEmpty(this.group_name.trim())) {
			logger.error("group name is empty");
			return false;
		}
		this.recipient_user_id = this.group_name;
		const result = await this.getRecipientPublicKey();
		this.group_public_key = this.recipient_public_key;

		this.saveSettings();

		return result;
	};

	async generateGroupKey()
	{
		this.group_passphrase = Group.randomPassword(30);

		const options = {
			userIds: [ {
				name: this.group_name.toLowerCase()
			} ], // multiple user IDs
			numBits: 2048,                // RSA key size
			passphrase: this.group_passphrase        // protects the private key
		};

		const key_object = await openpgp.generateKey(options);
		this.group_private_key = key_object.privateKeyArmored;
		this.group_public_key = key_object.publicKeyArmored;
	}

	async updateGroupPublicKey()
	{
		const payload = JSON.stringify({
			username: this.group_name.toLowerCase(),
			publicKey: this.group_public_key,
			is_group: "1",
			sub: this.group_type,
			phone: ' ',
			email: current_user.username
		});

		const result = await current_user.callLambda({
			FunctionName : 'Clinicoin-updatePublicKey',
			InvocationType : 'RequestResponse',
			Payload: payload,
			LogType : 'None'
		});

		return result;
	}

	async sendGroupMessage(message_json)
	{
		let msg = new Message();
		msg.Body = message_json;
		msg.Sender = current_user.username.toLowerCase();
		msg.Receiver = this.group_name.toLowerCase();

		if ( ! _.isEmpty(this.group_private_key)) {
			let private_key_obj = openpgp.key.readArmored(current_user.getPrivateKey()).keys[0];
			private_key_obj.decrypt(current_user.getPassphrase());
			await msg.encryptMessage(this.group_public_key, [private_key_obj]);
		}
		else {
			if (this.recipient_public_key === '') {
				this.recipient_public_key = this.group_public_key;
			}
			if (this.recipient_public_key === '') {
				await this.getRecipientPublicKey();
				this.group_public_key = this.recipient_public_key;
			}
			await msg.encryptMessage(this.recipient_public_key);
		}

		// send it to the server
		await this.sendToServer(msg.EncryptedBody, 'cmd');
	}

	static async userJoinRequest(group_name)
	{
		logger.info('calling joinGroup');

		if (_.isEmpty(group_name) || _.isEmpty(group_name.trim())) {
			logger.error("group name is empty");
			return 'group name is empty';
		}

		if (channels.findByUsername(group_name)) {
			logger.error('already joined/joining group');
			return 'already joined/joining group';
		}

		const new_group = new Group();
		new_group.recipient_user_id = group_name.toLowerCase();
		const exists = await new_group.getRecipientPublicKey();

		if ( ! exists) {
			logger.error("group with that name does not exist");
			return "group not found";
		}

		new_group.group_public_key = new_group.recipient_public_key;
		new_group.group_name = group_name.toLowerCase();

		await new_group.sendGroupMessage(JSON.stringify({ command: "join_request "+group_name }));

		new_group.group_status = 'requested';

		new_group.saveSettings();

		channels.addGroupChannel(new_group);

		return new_group;
	}

	async adminApproveJoin(user_name)
	{
		logger.info('approving join');

		this.recipient_user_id = user_name;
		await this.getRecipientPublicKey(user_name);

		this.user_list.push(user_name);

		const message_json = JSON.stringify({
			command: "join_approved",
			group: this.group_name.toLowerCase(),
			passphrase: this.group_passphrase,
			privatekey: this.group_private_key,
			publickey: this.group_public_key,
			admins: this.admin_list,
			users: this.user_list
		});

		let msg = new Message();
		msg.Body = message_json;
		msg.Sender = this.group_name;
		msg.Receiver = user_name;

		let private_key_obj = openpgp.key.readArmored(current_user.getPrivateKey()).keys[0];
		private_key_obj.decrypt(current_user.getPassphrase());
		await msg.encryptMessage(this.recipient_public_key, [ private_key_obj ]);

		await this.sendToServer(msg.EncryptedBody, 'cmd');

		this.sendGroupMessage(JSON.stringify({ command: "join_notify", username: user_name }));

		this.saveSettings();
	}

	async adminDenyJoin(user_name)
	{
		// not doing anything, currently...
	}

	async userJoinApprovalEvent(msg)
	{
		const msgjson = JSON.parse(msg.Body);
		this.group_status = msgjson.status;
		this.group_passphrase = msgjson.passphrase;
		this.group_private_key = msgjson.privatekey;
		this.group_public_key = msgjson.publickey;
		this.admin_list = msgjson.admins;
		this.user_list = msgjson.users;

		await this.saveSettings();

		msg.deleteFromServer();

		this.getAdminListKeys();
	}

	async getAdminListKeys()
	{
		for(let admin of this.admin_list) {
			this.getAdminKey(admin);
		}

		this.recipient_public_key = this.group_public_key;
	}

	async getAdminKey(admin)
	{
		let json = await store.getItem('gr_admin_' + admin, null);

		if (json !== null) {
			const data = JSON.parse(json);
			if (moment(data.date).isAfter(moment().subtract(24, 'hours'))) {
				return data.public;
			}
		}

		await this.getRecipientPublicKey(admin);

		if (this.recipient_public_key !== null) {
			await store.setItem('gr_admin_' + admin,
				JSON.stringify({
					date: moment().format('YYYY-MM-DD HH:mm:ss'),
					public: this.recipient_public_key
				}));
		}

		const public_key = this.recipient_public_key;
		this.recipient_public_key = this.group_public_key;

		return public_key;
	}

	async leave()
	{
		// if they are the only admin, they cannot leave
		if (this.admin_list === [current_user]) {
			logger.error('sole admin cannot leave group');
			this.last_error = 'sole admin cannot leave group';
			return false;
		}

		channels.removeGroupChannel(this.group_name);

		await this.sendGroupMessage(JSON.stringify({
			command: 'left',
			sender: current_user.username.toLowerCase()
		}));

		await this.removeSettings();

		return true;
	}

	async banMember(user_name)
	{
		logger.info('removing member');

		if (_.indexOf(this.user_name, user_name) === -1) {
			logger.error(user_name+' not a member, cannot ban');
			this.last_error = user_name+' not a member, cannot ban';
			return false;
		}

		this.user_list = _.without(this.user_list, user_name);

		this.sendGroupMessage(JSON.stringify({
			status: "removed",
			group: this.group_name.toLowerCase()
		}));

		this.distributeNewKey();

		return true;
	}

	async distributeNewKey()
	{
		logger.info('calling distributeNewKey');

		const old_public_key = this.group_public_key;

		await this.generateGroupKey();

		await this.updateGroupPublicKey();

		let options = {
			data: "-----BEGIN ENVELOPE-----"
			+ JSON.stringify({
				SentDate: moment().toISOString(),
				Sender: current_user.username.toLowerCase(),
				Receiver: this.group_name.toLowerCase()
			})
			+ "-----END ENVELOPE-----\n\n"+
			JSON.stringify({
				command: 'new_group_key',
				group: this.group_name.toLowerCase(),
				passphrase: this.group_passphrase,
				privatekey: this.group_private_key,
				publickey: this.group_public_key,
				admins: this.admin_list,
				users: this.user_list
			}),
			publicKeys: openpgp.key.readArmored(old_public_key).keys,
		};

		// signed with admin's private key
		let privKeyObj = openpgp.key.readArmored(current_user.getPrivateKey()).keys[0];
		privKeyObj.decrypt(current_user.getPassphrase());
		options.privateKeys = privKeyObj;

		const enc_object = await openpgp.encrypt(options);

		const key = 'cmd_'+moment().format('x')+(_.random(100, 999).toString());

		let all_users = _.union(this.user_list, this.admin_list);
		all_users = _.without(all_users, current_user.username);

		const payload = JSON.stringify({
			data: enc_object.data,
			sender: this.group_name.toLowerCase(),
			destinations: all_users.join(','),
			messageid: key
		});

		const bulkresult = await current_user.callLambda({
			FunctionName : 'Clinicoin-bulkSend',
			InvocationType : 'RequestResponse',
			Payload: payload,
			LogType : 'None'
		});

		return bulkresult.statusCode === 200;
	}

	async newKeyEvent(msg)
	{
		const msgjson = JSON.parse(msg.Body);
		this.group_passphrase = msgjson.passphrase;
		this.group_private_key = msgjson.privatekey;
		this.group_public_key = msgjson.publickey;
		this.admin_list = msgjson.admins;
		this.user_list = msgjson.users;

		await this.saveSettings();

		msg.deleteFromServer();
	}

	async adminPromote(admin_name)
	{
		await this.sendGroupMessage(JSON.stringify({ command: "promote", admin: admin_name }));
		this.adminPromoteEvent(admin_name);
	}

	async adminPromoteEvent(admin_name)
	{
		if (_.indexOf(this.user_list, admin_name) === -1) {
			logger.error(admin_name+' not found in list, cannot promote');
			this.last_error = admin_name+' not found in list, cannot promote';
			return false;
		}

		this.user_list = _.without(this.user_list, admin_name);
		this.admin_list.push(admin_name);
		this.admin_list = _.uniq(this.admin_list);
		await this.saveSettings();
		logger.debug(admin_name+' has been promoted');
		return true;
	}

	async adminDemote(admin_name)
	{
		await this.sendGroupMessage(JSON.stringify({ command: "demote", admin: admin_name }));
		this.adminDemoteEvent(admin_name);
	}

	async adminDemoteEvent(admin_name)
	{
		if (_.indexOf(this.admin_list, admin_name) === -1) {
			logger.error(admin_name+' not found in list, cannot demote');
			this.last_error = admin_name+' not found in list, cannot demote';
			return false;
		}

		this.admin_list = _.without(this.admin_list, admin_name);

		if (this.admin_list.length === 0) {
			logger.error('cannot demote only admin');
			this.last_error = 'cannot demote only admin';
			return false;
		}

		this.user_list.push(admin_name);
		this.user_list = _.uniq(this.user_list);
		await this.saveSettings();
		logger.debug(admin_name+' has been demoted');
		return true;
	}
}