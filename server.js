/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
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

const STD_MODEL = "./deepspeech-0.7.3-models.pbmm"
const STD_SCORER = "./deepspeech-0.7.3-models.scorer"
const STD_SAMPLE_RATE = 16000;
const execFile = require('child_process').execFile;
const path2buildDir = "/home/scorerbuilder/"

function createModel(modelPath, scorerPath) {
  let model = new DeepSpeech.Model(modelPath);
  model.enableExternalScorer(scorerPath);
  return model;
}

function metadataToString(all_metadata) {
  var transcript = all_metadata.transcripts[0];
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

/*************************************************
 SpellCheck Something
 Called from SQS->lambda->here OR browser

 **************************************************/
const SpellChecker = require('node-aspell');

app.post('/spellcheck', (req, res) => {
  try {
    if (!req.body.passage) {

      res.send({
        status: false,
        message: 'spellcheck: No passage included'
      });

    } else {
      console.log("*** start spellcheck ***");

      let lang = req.body.lang; //eg "en_US"
      let passage = req.body.passage;
      let vocab = req.body.vocab;

      const checker = new SpellChecker.Spellchecker(lang);
      let words = passage.split(' ');
      let returndata = {};
      returndata.results = [];
      for (var i = 0; i < words.length; i++) {
        returndata.results[i] = !checker.isMisspelled(words[i]);
      }
      console.log(JSON.stringify(returndata));
      //checker.isMisspelledAsync(word, callback)
      //send response
      res.send({
        status: true,
        message: 'Spell check complete.',
        data: returndata
      });
    }
  } catch (err) {
    console.log("ERROR");
    console.log(err);
    res.status(500).send();
  }
});


/*************************************************
 Lang tool proxy
 exects a lang tool server at local host on port 8081

 **************************************************/

app.post('/lt', (req, res) => {
  try {
    var proxy = require('request');
    proxy.post({
      url: 'http://localhost:8081/v2/check',
      form: {
        text: req.body.text,
        language: req.body.language
      }
    }, function(error, response, body) {
      if (error) {
        console.log('error posting  data', error);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.send(body);
      }
    });

  } catch (err) {
    console.log("ERROR");
    console.log(err);
    res.status(500).send();
  }
});

app.get("/", (req, res) => {

  res.status(200).send();

});

app.post('/stt', (req, res) => {

  console.log("new /stt endpoint triggered");

  try {

    if (!req.files) {
      return res.send({
        status: false,
        message: 'No file uploaded'
      });
    }

    if (!req.body.scorer) {
      return res.send({
        status: false,
        message: 'No scorer uploaded'
      });
    }

    var tmpname = Math.random().toString(20).substr(2, 6);
    var b64scorer = req.body.scorer;
    var buf = Buffer.from(b64scorer, 'base64');
    fs.writeFileSync("uploads/" + tmpname + "_scorer", buf);
    fs.writeFileSync("uploads/" + tmpname + "_blob", req.files.blob.data);

    var proc = ffmpeg("uploads/" + tmpname + "_blob")
      .format('wav')
      .audioCodec('pcm_s16le')
      .audioBitrate(16)
      .audioChannels(1)
      .withAudioFrequency(16000)
      // setup event handlers
      .on('end', function() {

        console.log('file has been converted succesfully');
        //DO SOMETHING HERE

        var model = createModel(STD_MODEL, "uploads/" + tmpname + "_scorer");
        var audioBuffer = fs.readFileSync("uploads/converted_" + tmpname + "_blob");
        var result = model.sttWithMetadata(audioBuffer);

        res.send({
          status: true,
          message: 'File transcribed.',
          transcript: metadataToString(result),
          result: 'success'
        });

        deleteFile("uploads/" + tmpname + "_scorer");
        deleteFile("uploads/" + tmpname + "_blob");
        deleteFile("uploads/converted_" + tmpname + "_blob");

      })
      .on('error', function(err) {
        console.log('an error happened: ' + err.message);
      })
      // save to file
      .save("uploads/converted_" + tmpname + "_blob");


  } catch (err) {

    console.log(err);

  }

})

/*************************************************
 Main method for /lm.php
 returns scorer for set of words and saves the scorer and text
 concurrent use is safe
 Called from TTD server/browser
 **************************************************/
app.post('/lm', (req, res) => {
  var data = req.body.data;
  var text = data.text;
  console.log("** Build Scorer for " + text);

  let tmpname = Math.random().toString(20).substr(2, 6);
  let tmp_textpath = path2buildDir + 'work/' + tmpname + '.txt';
  let tmp_scorerpath = path2buildDir + 'work/' + tmpname + '.scorer';
  write2File(tmp_textpath, text + "\n");

  // run script that builds model, callback after that is done and we moved scorer
  const child = execFile(path2buildDir + "ttd-lm.sh", [tmpname], (error, stdout, stderr) => {
    if (error) {
      console.error('stderr', stderr);
      throw error;
    }
    console.log('stdout', stdout);

    fs.readFile(tmp_scorerpath, function(err, data) {
      if (err) {
        //send response
        res.send({
          status: true,
          message: 'Scorer no good',
          result: "error"
        }); //end of res send
      } else {
        let buff = Buffer.from(data);
        let base64data = buff.toString('base64');

        //send response
        res.send({
          status: true,
          message: 'Scorer generated',
          result: "success",
          scorer: base64data
        }); //end of res send

        // script is done, scorer is built, mv scorer and txt
        deleteFile(tmp_scorerpath);
        deleteFile(tmp_textpath);
      }
    });

  }); //end of execfile

}); //end of app.get

const port = process.env.PORT || 3000;

var options = {};

var server = http.createServer(options, app);

server.listen(port, () =>
  console.log(`App is listening on port ${port}.`));

/* HELPER FUNCTIONS */

function deleteFile(path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    console.log(err);
  }
}

function write2File(path, content) {
  fs.appendFile(path, content, function(err) {
    if (err) return console.log(err);
    console.log('File written');
  });
}