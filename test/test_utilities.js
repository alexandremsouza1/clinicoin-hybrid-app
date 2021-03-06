/**
 * retrieves the last console message from Minilog
 * @returns message array
 */
const getLastConsoleMessage = function()
{
	const msg = _.last(Minilog.backends.array.get());
	return _.last(msg[2]); // array 1 is type, 2 is the text (and is an array)
};

/**
 * simple function to sleep
 * @param ms
 * @returns {Promise<any>}
 * @example await sleep(2000)
 */
const sleep = function(ms)
{
	return new Promise(resolve => setTimeout(resolve, ms));
};

const getMailsacEmailList = async function(email_address)
{
	// get the list
	let ax_list_promise = null;
	try {
		ax_list_promise = await axios.get('https://mailsac.com/api/addresses/'+email_address+'/messages?_mailsacKey='+MAILSAC_API_KEY);
	} catch(e) {
		return logger.error(e);
	}

	return ax_list_promise.data;
};

/**
 * get the last message from Mailsac.com
 * @param email_address
 * @returns {Promise<void>}
 */
const getLastMailsacEmail = async function(email_address)
{
	let list_response = await getMailsacEmailList(email_address);

	if (list_response.length === 0) {
		logger.debug('no emails');
		return null;
	}
	const msg_id = _.last(list_response)._id;

	// get the individual message
	let ax_msg_promise = null;
	try {
		ax_msg_promise = await axios.get('https://mailsac.com/api/addresses/'+email_address+'/messages/'+msg_id+'?_mailsacKey='+MAILSAC_API_KEY);
	} catch(e) {
		return logger.error(e);
	}

	let message = ax_msg_promise.data;

	// get the message body
	let ax_body_promise = null;
	try {
		ax_body_promise = await axios.get('https://mailsac.com/api/text/'+email_address+'/'+msg_id+'?_mailsacKey='+MAILSAC_API_KEY);
	} catch(e) {
		return logger.error(e);
	}

	message.body = ax_body_promise.data;

	return message;
};


const createAndConfirmUser = async function()
{
	// create a user
	let user = new User();
	user.is_first_login = true;
	user.name = 'test';
	user.username = 'test'+_.random(111111,999999); // random username
	user.email = user.username+'@mailsac.com';
	user.phone = '+12125551216';
	user.setAwsPassword('aGreatPhrase321!');
	const register_result = await user.registerUser();
	assert.isTrue(register_result, "user create failed\n\n"+getLastConsoleMessage());

	let code = '';
	for(let i=0; i < 29; i++) {
		await sleep(1000);

		// get the code
		const msg = await getLastMailsacEmail(user.email);
		if (msg != null) {
			code = msg.body;
			const myregexp = /(\d{6})/i;
			let match = myregexp.exec(code);
			if (match != null) {
				code = match[1];
				break;
			}
		}
	}

	const result = await user.verifyConfirmationCode(code);
	assert.isTrue(result, "result is false\n\n" + getLastConsoleMessage());

	return user;
};

const createConfirmLoginUser = async function()
{
	let user = await createAndConfirmUser();
	await sleep(1000); // sometimes the login comes too quick for the shard to see it
	let login_result = await user.login();
	if (!login_result) {
		login_result = await user.login();
	}
	return user;
};

const getDemoUser = function()
{
	let test_user = new User();
	test_user.name = 'test';
	test_user.username = 'demouser'; // random username
	test_user.email = test_user.username+"@mailsac.com";
	test_user.phone = '+12125551217';
	test_user.setAwsPassword('ffDemo@1234');
	return test_user;
};

const loginDemoUser = async function()
{
	let test_user = new User();
	test_user.username = 'demouser';
	test_user.setAwsPassword('ffDemo@1234');
	let login_result = await test_user.login();
	if (!login_result) {
		login_result = await test_user.login();
	}
	await sleep(1000);
	return test_user;
};

const waitForElement = async function(search_element, seconds)
{
	if (_.isEmpty(seconds)) {
		seconds = 30;
	}

	logger.debug('searching for '+search_element+" ("+seconds+")");

	for(let i=0; i < seconds; i++) {
		await sleep(1000);

		// look for element
		if ($(search_element).length > 0) {
			logger.debug('element found');
			break;
		}
		else {
			logger.debug('still looking for '+search_element);
		}
	}
};
