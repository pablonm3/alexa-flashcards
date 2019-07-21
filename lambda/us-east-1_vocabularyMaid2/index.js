const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const moment = require('moment');
const dynamodb = new AWS.DynamoDB({apiVersion: '2012-08-10'});
const parse = AWS.DynamoDB.Converter.unmarshall;
const stringSimilarity = require('string-similarity');

const TABLE_NAME = 'alexa-vocabulary-words';
const SKILL_NAME = 'flashcard maid';
const HELP_TEXT = `to create a new flashcard say add followed by its title, to practice them just say practice`;
const WELCOME_TEXT = `Welcome to ${SKILL_NAME}. ` + HELP_TEXT;
const MS_PER_DAY = 8.64e+7;
const LaunchRequestHandler = {
    canHandle(handlerInput) {
        console.log('can handle launch')
        return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
    },
    handle(handlerInput) {
        console.log('launch')
        // Our skill will receive a LaunchRequest when the user invokes the skill
        // with the  invocation name, but does not provide any utterance
        // mapping to an intent.
        // For Example, "Open code academy"
        const speakOutput = WELCOME_TEXT;

        // The response builder contains is an object that handles generating the
        // JSON response that your skill returns.
        return handlerInput.responseBuilder
            .speak(speakOutput) // The text passed to speak, is what Alexa will say.
            .reprompt(speakOutput)
            .getResponse();
    },
};

function dynamoPut(obj) {
    return new Promise((resolve, reject) => {
        console.log('about to insert in dynamo: ', JSON.stringify(obj))
        dynamodb.putItem({
            "TableName": TABLE_NAME,
            "Item": obj
        }, (err, res) => {
            if (err) {
                return reject(err)
            }
            resolve(res)
        });
    })

}

const AddHandler = {
    canHandle(handlerInput) {
        console.log('can handle addHandler')
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === 'addIntent';
    },
    async handle(handlerInput) {
        console.log('handle addHandler handlerInput: ', JSON.stringify(handlerInput))
        const word = handlerInput.requestEnvelope.request.intent.slots.WORD.value;
        const value = handlerInput.requestEnvelope.request.intent.slots.VALUE.value;
        const userId = handlerInput.requestEnvelope.session.user.userId;
        let r;
        const tomorrowInDays = Math.floor(moment().add(1, 'days').toDate().getTime() / MS_PER_DAY)
        try {
            // spaced repetition alghorithm: https://stackoverflow.com/questions/49047159/spaced-repetition-algorithm-from-supermemo-sm-2
            r = await dynamoPut({
                word: {S: word},
                value: {S: value},
                userId: {S: userId},
                id: {S: word + '_' + userId},
                repetitions: {N: "0"},
                iinterval: {N: "1"}, // interval is a reserved name
                easiness: {N: "2.5"},
                nextPractice: {N: tomorrowInDays.toString()}
            })
        } catch (e) {
            console.error('dynamo insert failed: ', e);
            return handlerInput.responseBuilder
                .speak("Sorry, something went wrong.")
                .getResponse();
        }
        console.log('result from dynamo baby: ', r);
        const speakOutput = 'Card created for concept: ' + word;

        // The response builder contains is an object that handles generating the
        // JSON response that your skill returns.
        return handlerInput.responseBuilder
            .speak(speakOutput) // The text passed to speak, is what Alexa will say.
            .getResponse();
    },
};

const PracticeHandler = {
    canHandle(handlerInput) {
        console.log('can handle PracticeHandler: ', handlerInput.requestEnvelope.request)
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === 'practiceIntent'
            && !(handlerInput.requestEnvelope.request.intent.slots || []).answer.value
    },
    async handle(handlerInput, baseSpeech = '', lastCardId) {
        console.log('handle practice Handler handlerInput: ', JSON.stringify(handlerInput))

        /*  1 - select card to practice, read value outloud & ask user to day which concept it is
            2 - compare users response with concept, speak result to user & update card with score
        * */
        const userId = handlerInput.requestEnvelope.session.user.userId;
        const todayInDays = Math.floor(new Date().getTime() / MS_PER_DAY);
        const attributes = handlerInput.attributesManager.getSessionAttributes();
        const cardQuery = {
            ExpressionAttributeValues: {
                ":userId": {
                    S: userId
                },
                ":todayInDays": {
                    N: todayInDays.toString()
                }
            },
            FilterExpression: 'userId = :userId AND nextPractice <= :todayInDays'
        }
        if (lastCardId) {
            // values for last practiced card could still be outdated in db, so need to avoid fetching it again
            cardQuery.ExpressionAttributeValues[":lastCardId"] = {S: lastCardId}
            cardQuery.FilterExpression += " AND id <> :lastCardId"
        }
        console.log('cardQuery: ', cardQuery)
        const r = await dynamodb.scan({
            TableName: TABLE_NAME,
            ...cardQuery
        }).promise();
        console.log('result from dynamo scan: ', r)
        console.log('r.Items[0]: ', r.Items[0]);
        const card = parse(r.Items[0])
        console.log('card: ', card);
        if (!card || !card.id) {
            return handlerInput.responseBuilder
                .speak(baseSpeech + "There are no cards left to practice, check again tomorrow, baby")
                .getResponse();
        }
        attributes.lastCard = card;
        handlerInput.attributesManager.setSessionAttributes(attributes);
        const speech = !baseSpeech ? "with which concept do you associate the following sentence? " : baseSpeech + 'Your next concept is '

        return handlerInput.responseBuilder
            .speak(speech + card.value)
            .reprompt("with which concept do you associate that sentence? ")
            .addElicitSlotDirective('answer')
            .getResponse();
    },
};

function updateSpRepetitionParams(card, quality) {
    if (quality < 0 || quality > 5) {
        throw new Error('quality must be between 0 & 5: ', quality)
    }
    // easiness factor
    card.easiness = Math.max(1.3, card.easiness + 0.1 - (5.0 - quality) * (0.08 + (5.0 - quality) * 0.02));

    // repetitions
    if (quality < 3) {
        card.repetitions = 0;
    } else {
        card.repetitions += 1;
    }

    // interval
    if (card.repetitions <= 1) {
        card.iinterval = 1;
    } else if (card.repetitions == 2) {
        card.iinterval = 6;
    } else {
        card.iinterval = Math.round(card.iinterval * card.easiness);
    }
    // next practice
    card.nextPractice = Math.floor(moment().add(card.iinterval, 'days').toDate().getTime() / MS_PER_DAY);

    //save changes
    dynamodb.updateItem({
        TableName: TABLE_NAME,
        Key: {
            "id": {
                S: card.id
            },
        },
        ExpressionAttributeValues: {
            ":easiness": {
                N: card.easiness.toString()
            },
            ":repetitions": {
                N: card.repetitions.toString()
            },
            ":iinterval": {
                N: card.iinterval.toString()
            },
            ":nextPractice": {
                N: card.nextPractice.toString()
            }
        },
        UpdateExpression: "SET easiness = :easiness, repetitions = :repetitions, iinterval = :iinterval, nextPractice = :nextPractice"
    }, err => {
        console.error(`dynamo update failed for card id: ${card.id} `, err)
    });
}

const AnswerHandler = {
    canHandle(handlerInput) {
        console.log('can handle AnswerHandler: ', handlerInput.requestEnvelope.request.intent)
        const attributes = handlerInput.attributesManager.getSessionAttributes();
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && ((handlerInput.requestEnvelope.request.intent.name === 'answerIntent' && attributes.lastCard)
                ||
                (handlerInput.requestEnvelope.request.intent.name === 'practiceIntent'
                    && (handlerInput.requestEnvelope.request.intent.slots ||[]).answer.value))
    },
    async handle(handlerInput) {
        console.log('handle an answerHandler handlerInput: ', JSON.stringify(handlerInput))
        // read answer, score it, update record with new score, speak result & prompt next card
        const attributes = handlerInput.attributesManager.getSessionAttributes();
        const card = attributes.lastCard;
        const answerSlot = handlerInput.requestEnvelope.request.intent.slots.answer.value;
        const score = stringSimilarity.compareTwoStrings(answerSlot, card.word) * 5; // score between 0 & 5
        console.log('score: ', score);
        let speech;
        if (score > 3) {
            speech = 'You got it baby. '
        } else {
            speech = 'oops, the answer is: ' + card.word + '. proceeding to next concept. '
        }
        // update record in dynamo with spaced repetition params
        updateSpRepetitionParams(card, score);
        attributes.lastCard = null;
        handlerInput.attributesManager.setSessionAttributes(attributes);
        return PracticeHandler.handle(handlerInput, speech, card.id)
    },
};

const testHandler = {
    canHandle(handlerInput) {
        console.log('can handle testHandler')
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === 'testIntent';
    },
    async handle(handlerInput) {
        console.log('handle testHandler')
        const speakOutput = 'hello world ';

        // The response builder contains is an object that handles generating the
        // JSON response that your skill returns.
        return handlerInput.responseBuilder
            .speak(speakOutput) // The text passed to speak, is what Alexa will say.
            .getResponse();
    },
};

const HelpHandler = {
    canHandle(handlerInput) {
        console.log('can handle helpHandler')
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && handlerInput.requestEnvelope.request.intent.name === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        console.log('handle helpHandler')
        const speakOutput = HELP_TEXT;

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt() // use reprompt here to keep session opened, not sure why it gets closed when removing it
            .getResponse();
    },
};

const CancelAndStopHandler = {
    canHandle(handlerInput) {
        console.log('can handle CancelAndStopHandler')
        return handlerInput.requestEnvelope.request.type === 'IntentRequest'
            && (handlerInput.requestEnvelope.request.intent.name === 'AMAZON.CancelIntent'
                || handlerInput.requestEnvelope.request.intent.name === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        console.log('handle handlerInput')
        const speakOutput = 'Goodbye!';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .getResponse();
    },
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        console.log('can handle SessionEndedRequestHandler')
        return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`Session ended with reason: ${handlerInput.requestEnvelope.request.reason}`);

        return handlerInput.responseBuilder.getResponse();
    },
};

const ErrorHandler = {
    canHandle() {
        console.log('can handle ErrorHandler')
        return true;
    },
    handle(handlerInput, error) {
        console.log(`Error handled: ${error.message}`);
        console.log(error.trace);

        return handlerInput.responseBuilder
            .speak('Sorry, I can\'t understand the command. Please say again.')
            .getResponse();
    },
};

const skillBuilder = Alexa.SkillBuilders.custom();

/**
 * Request Interceptor to log the request sent by Alexa
 */
const LogRequestInterceptor = {
    process(handlerInput) {
        // Log Request
        console.log("==== REQUEST ======");
        console.log(JSON.stringify(handlerInput.requestEnvelope, null, 2));
    }
}
/**
 * Response Interceptor to log the response made to Alexa
 */
const LogResponseInterceptor = {
    process(handlerInput, response) {
        // Log Response
        console.log("==== RESPONSE ======");
        console.log(JSON.stringify(response, null, 2));
    }
}

exports.handler = skillBuilder
    .addRequestHandlers(
        LaunchRequestHandler,
        AddHandler,
        PracticeHandler,
        AnswerHandler,
        testHandler,
        HelpHandler,
        CancelAndStopHandler,
        SessionEndedRequestHandler,
    )
    .addErrorHandlers(ErrorHandler)
    .addRequestInterceptors(LogRequestInterceptor)
    .addResponseInterceptors(LogResponseInterceptor)
    .lambda();
