const DeepSpeech = require('deepspeech')

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

exports.handler = async (event) => {

  var id;
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  writeLog("/stt: endpoint was triggered", ip, req.body.origin);

  if (req.body.hasOwnProperty("id")) {
    id = req.body.id;
  } else {
    id = null;
  }

  if (!req.files) {
    return res.send({
      id: id,
      result: "error",
      message: 'No blob specified'
    });
  }

  if (!req.body.origin) {
    return res.send({
      id: id,
      result: "error",
      message: 'No origin specified'
    });
  }

  var tmpname = Math.random().toString(20).substr(2, 6);
  var scorerPath = __dirname + "/" + tmpname + "_scorer";
  var blobPath = __dirname + "/" + tmpname + "_blob";

  if (req.body.scorer) {
    var b64scorer = req.body.scorer;
    var buf = Buffer.from(b64scorer, 'base64');
    fs.writeFileSync(scorerPath, buf);
  }

  fs.writeFileSync(blobPath, req.files.blob.data);

  console.log("starting recognition..");

  var model, beamWidth;

  if (fs.existsSync(scorerPath)) {
    beamWidth = 500;
    console.log("creating model with custom scorer..");
    model = createModel(STD_MODEL, scorerPath);
  } else {
    beamWidth = 2000;
    console.log("creating model with standard scorer..");
    model = createModel(STD_MODEL, STD_SCORER);
  }

  model.setBeamWidth(beamWidth);

  var maxAlternates = 1;
  var audioBuffer = fs.readFileSync(blobPath);

  var result = model.sttWithMetadata(audioBuffer, maxAlternates);

  if (fs.existsSync(scorerPath)) {
    console.log("deleting scorer..");
    fs.unlinkSync(scorerPath);
  }

  if (fs.existsSync(blobPath)) {
    console.log("deleting blob..");
    fs.unlinkSync(blobPath);
  }

  var transcript = metadataToString(result, 0);

  console.log("returning transcript..");

  return transcript;
};

function writeLog(log, ip, origin) {
  console.log(log);
  nodefetch('http://ec2-18-183-39-101.ap-northeast-1.compute.amazonaws.com:3000/write_log', {
    method: 'post',
    body: JSON.stringify({
      "log": log,
      "ip": ip,
      "origin": origin
    }),
    headers: {
      'Content-Type': 'application/json'
    },
  })
    .then(function (res) {
      res.json()
    })
    .then(function (json) {
      //do something
    });
}