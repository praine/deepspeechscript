/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
const queue = require('express-queue');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
const app = express();
const DeepSpeech = require('deepspeech');
const request = require("request");
const fs = require('fs');
const http = require('http');
const url = require('url');
const fileUpload = require("express-fileupload");
const ffmpeg = require("fluent-ffmpeg");
const nodefetch = require('node-fetch');

const ACTIVE_LIMIT = 1;
const QUEUED_LIMIT = 100;
const STD_MODEL = "/home/ubuntu/deepspeech-0.9.3-models.tflite"
const STD_SCORER = "/home/ubuntu/deepspeech-0.9.3-models.scorer"
const STD_SAMPLE_RATE = 16000;

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

app.use(fileUpload({
  createParentPath: true
}));
app.options('*', cors())
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(morgan('dev'));
const queueMw = queue({
  activeLimit: ACTIVE_LIMIT,
  queuedLimit: QUEUED_LIMIT,
  rejectHandler: (req, res) => {
    var id;
    if (req.body.hasOwnProperty("id")) {
      id = req.body.id;
    } else {
      id = null;
    }
    return res.send({
      id: id,
      result: "error",
      message: 'Server busy. Please try again.'
    });
  }
});

app.use(queueMw);

app.get("/", (req, res) => {

  return res.status(200).send();

});

app.post('/stt', (req, res) => {

  console.log(`queueLength: ${queueMw.queue.getLength()}`);

  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  try {

    var id;

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

    console.log("/stt: endpoint triggered", ip, req.body.origin);

    var tmpname = Math.random().toString(20).substr(2, 6);

    if (req.body.scorer) {
      var b64scorer = req.body.scorer;
      var buf = Buffer.from(b64scorer, 'base64');
      fs.writeFileSync("/home/ubuntu/uploads/" + tmpname + "_scorer", buf);
    }

    fs.writeFileSync("/home/ubuntu/uploads/" + tmpname + "_blob", req.files.blob.data);

    var proc = ffmpeg("/home/ubuntu/uploads/" + tmpname + "_blob")
      .format('wav')
      .audioCodec('pcm_s16le')
      .audioBitrate(16)
      .audioChannels(1)
      .withAudioFrequency(16000)
      .on('end', function() {

        var model, beamWidth;

        if (req.body.scorer) {
          beamWidth = 500;
          model = createModel(STD_MODEL, "/home/ubuntu/uploads/" + tmpname + "_scorer");
        } else {
          beamWidth = 2000;
          model = createModel(STD_MODEL, STD_SCORER);
        }

        model.setBeamWidth(beamWidth);

        var maxAlternates = 1;
        var audioBuffer = fs.readFileSync("/home/ubuntu/uploadsconverted_" + tmpname + "_blob");

        var result = model.sttWithMetadata(audioBuffer, maxAlternates);

        if (req.body.scorer) {
          deleteFile("/home/ubuntu/uploads/" + tmpname + "_scorer");
        }

        deleteFile("/home/ubuntu/uploads/" + tmpname + "_blob");
        deleteFile("/home/ubuntu/uploadsconverted_" + tmpname + "_blob");

        var transcript = metadataToString(result, 0);

        console.log("/stt: got result (" + transcript + ")", ip, req.body.origin);

        return res.send({
          id: id,
          result: "success",
          transcript: transcript,
        });

      })
      .on('error', function(err) {
        console.log("/stt: error (" + err.message + ")", ip, req.body.origin);
      })
      // save to file
      .save("/home/ubuntu/uploadsconverted_" + tmpname + "_blob");


  } catch (err) {
    console.log("/stt: error (" + JSON.stringify(err) + ")", ip, req.body.origin);
  }

});

const port = process.env.PORT || 3000;

var server = http.createServer(app);

server.listen(port, () => console.log(`App is listening on port ${port}.`));

/* HELPER FUNCTIONS */

function deleteFile(path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    console.log(err);
  }
}
