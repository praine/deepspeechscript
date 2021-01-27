const DeepSpeech = require('deepspeech');
const fs = require('fs');
const STD_MODEL = "/home/ubuntu/deepspeech-0.9.3-models.tflite"
const STD_SCORER = "/home/ubuntu/deepspeech-0.9.3-models.scorer"
const STD_SAMPLE_RATE = 16000;

const {
  workerData,
  parentPort
} = require('worker_threads')

console.log("starting recognition..");

var tmpname = Math.random().toString(20).substr(2, 6);

if (workerData.scorer) {
  var b64scorer = workerData.scorer;
  var buf = Buffer.from(b64scorer, 'base64');
  console.log("writing scorer..");
  fs.writeFileSync("/home/ubuntu/uploads/" + tmpname + "_scorer", buf);
}

fs.writeFileSync("/home/ubuntu/uploads/" + tmpname + "_blob", workerData.blob);

var model, beamWidth;

if (workerData.scorer) {
  beamWidth = 500;
  console.log("creating model with custom scorer..");
  model = createModel(STD_MODEL, "/home/ubuntu/uploads/" + tmpname + "_scorer");
} else {
  beamWidth = 2000;
  console.log("creating model with standard scorer..");
  model = createModel(STD_MODEL, STD_SCORER);
}

model.setBeamWidth(beamWidth);

var maxAlternates = 1;
var audioBuffer = fs.readFileSync("/home/ubuntu/uploads/" + tmpname + "_blob");

var result = model.sttWithMetadata(audioBuffer, maxAlternates);

if (workerData.scorer) {
  console.log("deleting scorer..");
  deleteFile("/home/ubuntu/uploads/" + tmpname + "_scorer");
}

console.log("deleting blob..");
deleteFile("/home/ubuntu/uploads/" + tmpname + "_blob");

var transcript = metadataToString(result, 0);

console.log("returning transcript..");

parentPort.postMessage({
  transcript: transcript
})

function deleteFile(path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    console.log(err);
  }
}

function createModel(modelPath, scorerPath) {
  let model = new DeepSpeech.Model(modelPath);
  model.enableExternalScorer(scorerPath);
  return model;
}

function metadataToString(all_metadata, idx) {
  var transcript = all_metadata.transcripts[idx];
  var retval = ""
  for (var i = 0; i < transcript.tokens.length; ++i) {
    retval += transcript.tokens[i].text;
  }
  return retval;
}