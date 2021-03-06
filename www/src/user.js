

let current_user = new User();

function User() {
    this.username = '';
    this.awsSub = '';
	this.email = '';
	this.email_verified = false;
	this.phone = '';
	this.phone_verified = false;
	this.country_code = { country: "United States", code: 1 };
	this.name = '';
	this.last_error_code = '';
	this.last_error_message = '';
	this.is_first_login = false;

	this.cognitoUser = null;
	this.jwtToken = '';

	let aws_password = '';
	let passphrase = '';
    let private_key = '';
    let public_key = '';

	this.getAwsPassword = function()
	{
		if (_.isEmpty(aws_password) && !_.isEmpty(passphrase)) {
			return passphrase;
		}
		return aws_password;
	};

	this.setAwsPassword = function(new_password)
	{
		aws_password = new_password;
	};

	this.getPassphrase = function()
	{
		if (!_.isEmpty(aws_password) && _.isEmpty(passphrase)) {
			return aws_password;
		}
		return passphrase;
	};

	this.setPassphrase = function(new_passphrase)
	{
		passphrase = new_passphrase;
	};

    this.getPublicKey = function()
    {
    	return public_key;
    };

	this.setPublicKey = function(new_key)
	{
		public_key = new_key;
	};

	this.getPrivateKey = function()
	{
		return private_key;
	};

	this.setPrivateKey = function(new_key)
	{
		private_key = new_key;
	};

	this.toJSON = function()
	{
		return JSON.stringify({
			username: this.username,
			awsSub: this.awsSub,
			email: this.email,
			email_verified: this.email_verified,
			phone: this.phone,
			phone_verified: this.phone_verified,
			name: this.name,
			private_key: this.getPrivateKey(),
			public_key: this.getPublicKey(),
			jwt_token: this.jwtToken,
			country_code: this.country_code
		});
	};

	this.fromJSONString = function(json_string)
	{
		if (_.isEmpty(json_string)) {
			return;
		}
		const data = JSON.parse(json_string);
		this.username = data.username;
		this.awsSub = data.awsSub;
		this.email = data.email;
		this.email_verified = data.email_verified;
		this.phone = data.phone;
		this.phone_verified = data.phone_verified;
		this.name = data.name;
		this.setPrivateKey(data.private_key);
		this.setPublicKey(data.public_key);
		this.jwtToken = data.jwt_token;
		this.country_code = data.country_code;
	};
}

/**
 * Generate a PGP for use, setting to the private properties
 * @returns true on success
 */
User.prototype.generateKey = async function()
{
	logger.info('generating new key');

	if (_.isEmpty(this.email)) {
		logger.error('email is empty');
		return false;
	}

	if (_.isEmpty(this.phone)) {
		logger.error('phone is empty');
		return false;
	}

	if (_.isEmpty(this.getPassphrase())) {
		logger.error('passphrase is empty');
		return false;
	}

    const options = {
        userIds: [ {
            name: this.name,
            email: this.email,
            phone: this.phone
        } ], // multiple user IDs
        numBits: 2048,                // RSA key size
        passphrase: this.getPassphrase()        // protects the private key
    };

    const key_object = await openpgp.generateKey(options);
    this.setPrivateKey(key_object.privateKeyArmored);
    this.setPublicKey(key_object.publicKeyArmored);

	logger.info('key return success');
	//logger.debug('private: '+key_object.privateKeyArmored);
	//logger.debug('public: '+key_object.publicKeyArmored);

    return true;
};

/**
 * register a new user with the system
 * @returns true on success
 */
User.prototype.registerUser = async function()
{
	logger.info('Registering new user');

	if (_.isEmpty(this.email)) {
		logger.error('email is empty');
		return false;
	}

	if (_.isEmpty(this.phone)) {
		logger.error('phone is empty');
		return false;
	}

	if (this.phone.length === 10 && ! _.startsWith(this.phone, '+')) {
		// assume it's a NADP number
		this.phone = '+1'+this.phone;
	}
	else if ( ! _.startsWith(this.phone, '+')) {
		// add a + if it does not already have one
		this.phone = '+'+this.phone;
	}

	if (_.isEmpty(this.getAwsPassword())) {
		logger.error('aws password is empty');
		return false;
	}

	if (_.isEmpty(this.username)) {
		logger.error('username is empty');
		return false;
	}

	if (this.username.replace(/\W+/ig, "") !== this.username) {
		logger.error('username contains non-word characters');
		return false;
	}

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	let userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);

	let attributeList = [];

	const attributeEmail = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserAttribute({ Name : 'email', Value : this.email });
	attributeList.push(attributeEmail);

	const attributePhoneNumber = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserAttribute({ Name : 'phone_number', Value : this.phone });
	attributeList.push(attributePhoneNumber);

	const signup_promise = new Promise((resolve) =>
		userPool.signUp(this.username, this.getAwsPassword(), attributeList, null, (err, result) => {
			if (err) {
				resolve({ error: err });
			}
			else {
				resolve(result);
			}
		})
	);

	const result = await signup_promise;

	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('cognito user: ' + result.user.getUsername());
		this.awsSub = result.userSub;
		this.setInStorage();
		return true;
	}
};

User.prototype.isLoggedIn = async function()
{
	const self = this;
	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	const userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);
	const cognitoUser = userPool.getCurrentUser();
	this.cognitoUser = cognitoUser;

	// not logged in
	if (cognitoUser === null) {
		return false;
	}
	this.username = userPool.getCurrentUser().username;

	if (cognitoUser != null) {
		const login_promise = new Promise((resolve) => {
			cognitoUser.getSession(function(err, session) {
				if (err) {
					logger.warn('user not logged in');
					resolve(false);
				} else {
					const valid = session.isValid();
					if (valid) {
						if (_.isEmpty(this.cognitoUser)) {
							//POTENTIAL: Region needs to be set if not already set previously elsewhere.
							AWS.config.region = AWS_REGION;


							self.jwtToken = session.getIdToken().getJwtToken();

							AWS.config.credentials = new AWS.CognitoIdentityCredentials({
								IdentityPoolId: AWS_IDENTITY_POOL_ID, // your identity pool id here
								Logins: {
									// Change the key below according to the specific region your user pool is in.
									'cognito-idp.us-east-1.amazonaws.com/us-east-1_bI9yWquBE': self.jwtToken
								}
							});
						}
						logger.debug('user logged in');
					}
					else {
						logger.warn('user not logged in');
					}
					resolve(valid);
				}
			});
		});

		return await login_promise;
	}

	return false;
};

/**
 * login a confirmed user
 * @returns true on success
 */
User.prototype.login = async function()
{
	logger.info('user aws login');

	let self = this;

	if (_.isEmpty(this.getAwsPassword())) {
		logger.error('password is empty');
		return false;
	}

	if (_.isEmpty(this.username)) {
		logger.error('username is empty');
		return false;
	}

	const authenticationData = {
		Username : this.username,
		Password : this.getAwsPassword()
	};

	let authenticationDetails = new AWSCognito.CognitoIdentityServiceProvider.AuthenticationDetails(authenticationData);

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};

	let userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);

	let userData = {
		Username : this.username,
		Pool : userPool
	};

	this.cognitoUser = new AWSCognito.CognitoIdentityServiceProvider.CognitoUser(userData);

	const auth_promise = new Promise((resolve) =>
		this.cognitoUser.authenticateUser(authenticationDetails, {
			onSuccess: async function (result) {
				logger.info('auth success');
				//logger.debug('access token + ' + result.getAccessToken().getJwtToken());
				self.awsSub = result.idToken.payload.sub;

				//POTENTIAL: Region needs to be set if not already set previously elsewhere.
				AWS.config.region = AWS_REGION;

				AWS.config.credentials = new AWS.CognitoIdentityCredentials({
					IdentityPoolId: AWS_IDENTITY_POOL_ID, // your identity pool id here
					Logins: {
						// Change the key below according to the specific region your user pool is in.
						'cognito-idp.us-east-1.amazonaws.com/us-east-1_bI9yWquBE': result.getIdToken().getJwtToken()
					}
				});

				logger.debug('refresh aws credentials');

				//refreshes credentials using AWS.CognitoIdentity.getCredentialsForIdentity()
				const refresh_promise = new Promise((resolve) => {
					AWS.config.credentials.refresh((error) => {
						if (error) {
							resolve({error:error});
						} else {
							console.log('Successfully logged!');
							resolve({});
						}
					});
				});

				const refresh_result = await refresh_promise;
				if (refresh_result.error) {
					resolve({error:refresh_result.error});
				}

				logger.debug('refresh success');


				resolve({});
			},
			onFailure: function (err) {
				resolve({ error: err });
			}
		})
	);

	const result = await auth_promise;

	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('login success');

		if (this.is_first_login) {
			this.is_first_login = false;
			this.provisionUser();
		}

		return true;
	}
};

User.prototype.provisionUser = async function()
{
	logger.debug('provisioning user');

	await this.generateKey();

	Promise.all([
		this.updatePublicKey(),
		this.setInStorage()
	]).then(()=>{
		this.sendWelcomeMessage();
	}).then(()=>{
		channels.checkForMessages(this.username, false);
	})
};

User.prototype.sendWelcomeMessage = async function()
{
	let msg_list = new MessageList();
	msg_list.recipient_user_id = this.username;
	msg_list.recipient_public_key = this.getPublicKey();
	let msg = new Message();
	msg.Sender = "Mosio-Clinicoin";
	msg.Receiver = this.username;
	msg.Body = "Welcome to Clinicoin";
	msg.MessageId = 1;

	let signPrivateKeyObj = openpgp.key.readArmored(this.getPrivateKey()).keys[0];
	signPrivateKeyObj.decrypt(this.getPassphrase());

	await msg.encryptMessage(this.getPublicKey(), [signPrivateKeyObj]);
	await msg_list.sendToServer(msg.EncryptedBody);
};

/**
 * touch the credentials on AWS to refresh
 * @returns true on success
 */
User.prototype.verifyConfirmationCode = async function(confirmation_code)
{
	logger.info('confirming user code');

	if (confirmation_code.length != 6) {
		this.last_error_message = 'confirmation code length not good';
		logger.error('confirmation code length not good');
		return false;
	}

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	let userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);

	let userData = {
		Username : this.username,
		Pool : userPool
	};

	let cognitoUser = new AWSCognito.CognitoIdentityServiceProvider.CognitoUser(userData);

	const verify_promise = new Promise((resolve) => {
		cognitoUser.confirmRegistration(confirmation_code, true, function(error, result) {
			if (error) {
				resolve({error:error});
			} else {
				resolve({ data: result });
			}
		});
	});

	const result = await verify_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('Registration Confirm: '+result.data);
		return true;
	}
};

/**
 * resend the confirmation code email/sms
 * @returns true on success
 */
User.prototype.resendConfirmationCode = async function()
{
	logger.info('re-sending user code');

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	let userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);
	let userData = {
		Username : this.username,
		Pool : userPool
	};
	let cognitoUser = new AWSCognito.CognitoIdentityServiceProvider.CognitoUser(userData);

	const resend_promise = new Promise((resolve) => {
		cognitoUser.resendConfirmationCode(function(error) {
			if (error) {
				resolve({error:error});
			} else {
				resolve({});
			}
		});
	});

	const result = await resend_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('resend success');
		return true;
	}
};

User.prototype.isComplexPassword = function(new_password)
{
	return /(?=\S*?[A-Z])(?=\S*?[a-z])(?=\S*?[0-9])(?=\S*?[^0-9a-zA-Z])\S{8,}/.test(new_password);
};

User.prototype.changeUserPassword = async function(new_password)
{
	logger.info('changing password');

	if (!this.isComplexPassword(new_password)) {
		logger.error('passphrase does not match having at least 8 letters, numbers, mixed case, and special characters');
		return false;
	}

	const pw_promise = new Promise((resolve) => {
		try {
			this.cognitoUser.changePassword(this.getAwsPassword(), new_password, function (err) {
				if (err) {
					resolve({error: err});
				}
				else {
					resolve({});
				}
			});
		}
		catch (ex) {
			resolve({error: ex.message});
		}
	});

	const result = await pw_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('password changed');
		this.setAwsPassword(new_password);
		this.setPassphrase(new_password);
		this.generateKey().then(()=>{
			this.updatePublicKey();
			this.setInStorage();
		});
		return true;
	}
};

User.prototype.getAwsUserAttributes = async function()
{
	logger.info('retrieving attributes');

	if (_.isEmpty(this.username)) {
		logger.error('username is blank');
		return false;
	}

	const attr_promise = new Promise((resolve) => {
		this.cognitoUser.getUserAttributes(function(err, result) {
			if (err) {
				resolve({error:err});
			} else {
				resolve({data:result});
			}
		});
	});

	const result = await attr_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		this.awsSub = _.find(result.data, {'Name':'sub'}).Value;
		this.email = _.find(result.data, {'Name':'email'}).Value;
		this.email_verified = _.find(result.data, {'Name':'email_verified'}).Value;
		this.phone = _.find(result.data, {'Name':'phone_number'}).Value;
		this.phone_verified = _.find(result.data, {'Name':'phone_number_verified'}).Value;
		return result.data;
	}
};

User.prototype.updateDynamoAttribute = async function(attribute_name, attribute_value)
{
	logger.info('updating attributes');

	if (_.isEmpty(attribute_name)) {
		logger.error('attribute name is blank');
		return false;
	}

	const dynamodb = new AWS.DynamoDB({apiVersion: '2012-08-10'});

	const params = {
		ExpressionAttributeNames: { "#Y": attribute_name },
		ExpressionAttributeValues: { ":y": { S: attribute_value } },
		Key: { "UserId": { S: this.username } },
		ReturnValues: "UPDATED_NEW",
		TableName: "ClinicoinDirectory",
		UpdateExpression: "SET #Y = :y"
	};

	const attr_promise = new Promise((resolve) => {
		dynamodb.updateItem(params, function(err, result) {
			if (err) {
				resolve({error:err});
			} else {
				resolve({});
			}
		});
	});

	const result = await attr_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('attribute changed');
		return true;
	}
};

User.prototype.updateUserAttribute = async function(attribute_name, attribute_value)
{
	logger.info('updating attributes');

	if (_.isEmpty(attribute_name)) {
		logger.error('attribute name is blank');
		return false;
	}

	let attributeList = [];
	const attribute = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserAttribute({
		Name : attribute_name,
		Value : attribute_value
	});
	attributeList.push(attribute);

	const attr_promise = new Promise((resolve) => {
		this.cognitoUser.updateAttributes(attributeList, function(err, result) {
			if (err) {
				resolve({error:err});
			} else {
				resolve({});
			}
		});
	});

	const result = await attr_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('attribute changed');
		return true;
	}
};

User.prototype.logout = async function()
{
	logger.info('logout user');

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	const userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);

	const cognitoUser = userPool.getCurrentUser();
	if (!_.isEmpty(cognitoUser)) {
		cognitoUser.signOut();

		cognitoUser.globalSignOut({
			onFailure: e =>   logger.error(e),
			onSuccess: r => logger.debug(data)
		});
	}
	else {
		logger.info('user not logged in in order to log out')
	}

	return true;
};

User.prototype.userForgotPassword = async function()
{
	logger.info('forgot password');

	if (_.isEmpty(this.username)) {
		logger.error('username is blank');
		return false;
	}

	let poolData = {
		UserPoolId : USER_POOL_ID,
		ClientId : CLIENT_ID
	};
	let userPool = new AWSCognito.CognitoIdentityServiceProvider.CognitoUserPool(poolData);
	let userData = {
		Username : this.username,
		Pool : userPool
	};
	let cognitoUser = new AWSCognito.CognitoIdentityServiceProvider.CognitoUser(userData);

	const pw_promise = new Promise((resolve) => {
		cognitoUser.forgotPassword({
			onSuccess: function (data) {
				resolve({data:data});
			},
			onFailure: function(err) {
				resolve({error:err});
			}
		});
	});

	const result = await pw_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('forgot pw sent');
		return true;
	}
};

User.prototype.forgotPasswordReset = async function(confirmation_code, new_password)
{
	logger.info('forgot password reset');

	if (_.isEmpty(this.username)) {
		logger.error('username is blank');
		return false;
	}

	if (!this.isComplexPassword(new_password)) {
		logger.error('passphrase does not match having at least 8 letters, numbers, mixed case, and special characters');
		return false;
	}

	// have to use the full provider to get to the confirm method
	let provider = new AWS.CognitoIdentityServiceProvider({apiVersion: '2016-04-18', region: AWS_REGION});

	const params = {
		ClientId: CLIENT_ID,
		ConfirmationCode: confirmation_code,
		Password: new_password,
		Username: this.username
	};

	const pw_promise = new Promise((resolve) => {
		provider.confirmForgotPassword(params, (err)=>{
			if (err) {
				resolve({error:err});
			} else {
				resolve({});
			}
		});
	});

	const result = await pw_promise;
	if (result.error) {
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return false;
	}
	else {
		logger.info('forgot pw change confirmed');
		this.setAwsPassword(new_password);
		this.setPassphrase(new_password);
		this.generateKey().then(()=>{
			this.updatePublicKey();
			this.setInStorage();
		});
		return true;
	}
};

User.prototype.callLambda = async function(invoke_params)
{
	logger.info('calling lambda');
	logger.debug(invoke_params);

	const lambda = new AWS.Lambda({region: AWS_REGION, apiVersion: '2015-03-31'});

	const lambda_promise = new Promise((resolve) => {
		lambda.invoke(invoke_params, function(err, data) {
			if (err) {
				resolve({error:err});
			} else {
				resolve({data:data});
			}
		});
	});

	const result = await lambda_promise;
	if (result.error) {
		logger.debug(result.error);
		logger.error(result.error.code + " - " + result.error.message);
		this.last_error_code = result.error.code;
		this.last_error_message = result.error.message;
		return {};
	}
	else {
		logger.debug(result.data);
		logger.info('lambda success');
		return JSON.parse(result.data.Payload);
	}
};

User.prototype.updatePublicKey = async function()
{
	logger.info('calling updatePublicKey');

	let key = this.getPublicKey();

	if (_.isEmpty(key)) {
		logger.error('public key is blank');
		return false;
	}

	const payload = JSON.stringify({
		username: this.username,
		sub: this.awsSub,
		publicKey: key,
		phone: this.phone,
		email: this.email,
		is_group: "0"
	});

	const result = await this.callLambda({
		FunctionName : 'Clinicoin-updatePublicKey',
		InvocationType : 'RequestResponse',
		Payload: payload,
		LogType : 'None'
	});

	return result.statusCode === 200;
};

User.prototype.deleteUser = async function()
{
	logger.info('calling updatePublicKey');

	if (_.isEmpty(this.username)) {
		logger.error('username is blank');
		return false;
	}

	const result = await this.callLambda({
		FunctionName : 'Clinicoin-deleteUser',
		InvocationType : 'RequestResponse',
		Payload: JSON.stringify({username: this.username}),
		LogType : 'None'
	});

	return result.statusCode === 200;
};

User.prototype.getFromStorage = async function(username)
{
	// if parameter is empty, look for the property user
	if (_.isEmpty(username)) {
		username = this.username;
	}

	// if still empty, load the default user (last user saved)
	if (_.isEmpty(username)) {
		username = await store.getItem('default_user');
	}

	// still no user? go back empty handed
	if (_.isEmpty(username)) {
		logger.error('no user to retrieve');
		return false;
	}

	const data = await store.getItem('User_'+username);

	this.fromJSONString(data);

	this.setDefaultUser();

	return true;
};

User.prototype.setInStorage = async function()
{
	this.setDefaultUser();
	return await store.setItem('User_'+this.username, this.toJSON());
};

User.prototype.setDefaultUser = function()
{
	store.setItem('default_user', this.username);
};

User.prototype.getActivities = async function()
{
	const act = new Activity();
	return act.getActivites();
};

User.prototype.addActivity = async function(activity_type, amount, units)
{
	let act = new Activity();
	act.ActivityType = activity_type;
	act.Amount = amount;
	act.Units = units;
	await act.save();
	return act;
};

User.prototype.sendSupportRequest = async function(subject, message)
{
	if (_.isEmpty(subject.trim())) {
		logger.error('subject cannot be empty');
	}
	else if (_.isEmpty(message.trim())) {
		logger.error('message cannot be empty');
	}
	else {
		message += "\n\n\n" + _.takeRight(Minilog.backends.array.get(), 100);

		const data = {
			name: this.name,
			email: this.email,
			subject: subject,
			message: message
		};

		axios.defaults.headers.post['Content-Type'] = 'application/x-www-form-urlencoded';

		const result = await axios.post('https://devdaaron.mosio.com/c/support_entry', data);

		return result.status == 200;
	}

	return false;
};