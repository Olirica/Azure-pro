import 'dotenv/config';
import fs from 'fs';
import sdk from 'microsoft-cognitiveservices-speech-sdk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('wav', {type:'string', demandOption:true})
  .option('lang', {type:'string', default:'en-US'})
  .option('maxFinalSec', {type:'number', default:10})
  .argv;

const audioData = fs.readFileSync(argv.wav);
const pushStream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000,16,1));
pushStream.write(audioData);
pushStream.close();

const speechConfig = sdk.SpeechConfig.fromSubscription(process.env.SPEECH_KEY, process.env.SPEECH_REGION);
speechConfig.speechRecognitionLanguage = argv.lang;
speechConfig.outputFormat = sdk.OutputFormat.Detailed;
speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestSentenceBoundary, 'true');
speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestPunctuationBoundary, 'true');
speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_StablePartialResultThreshold, '4');

const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

const t0 = Date.now();
let firstFinalAt = null;
let lastPartialAt = null;

recognizer.recognizing = (_, e) => {
  lastPartialAt = Date.now();
  const lagMs = lastPartialAt - t0;
  console.log(JSON.stringify({ev:'recognizing', t_ms: lagMs, text: e.result?.text || ''}));
};

recognizer.recognized = (_, e) => {
  const now = Date.now();
  const lagMs = now - t0;
  if (!firstFinalAt) firstFinalAt = now;
  console.log(JSON.stringify({ev:'final', t_ms: lagMs, text: e.result?.text || ''}));
};

recognizer.canceled = (_, e) => {
  console.error('canceled', e);
};
recognizer.sessionStopped = () => {
  const finalSec = firstFinalAt ? (firstFinalAt - t0)/1000 : null;
  console.log(JSON.stringify({ev:'done', first_final_sec: finalSec}));
  if (finalSec == null || finalSec > argv.maxFinalSec) process.exit(2);
  process.exit(0);
};

recognizer.startContinuousRecognitionAsync();
