/*************************************************
    Standard imports
 **************************************************/
const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
const app = express();
const DeepSpeech = require('deepspeech');
const Sox = require('sox-stream');
const MemoryStream = require('memory-stream');
const Duplex = require('stream').Duplex;
const Wav = require('node-wav');
const request = require("request");
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

/*************************************************
    Initial values for models,
    change path or name here
 **************************************************/

let STD_MODEL = "./deepspeech-0.7.3-models.pbmm"
let STD_SCORER = "./deepspeech-0.7.3-models.scorer"
let STD_SAMPLE_RATE = 16000; // std for deepspeech

/*************************************************
    Returns a model for given model and scorer path
 **************************************************/
function createModel(modelPath, scorerPath) {
	let model = new DeepSpeech.Model(modelPath);
	model.enableExternalScorer(scorerPath);
	return model;
}

/*************************************************
    Helper functions
 **************************************************/
function metadataToString(all_metadata) {
	var transcript = all_metadata.transcripts[0];
	var retval = ""
		for (var i = 0; i < transcript.tokens.length; ++i) {
			retval += transcript.tokens[i].text;
		}
		return retval;
}

function metadataToAWSFormat(all_metadata,transcript) {
        var aws = {};
        aws.jobName='jobname';
        aws.accountId='12345';
        aws.results={};
        aws.results.transcripts =[];
        aws.results.transcripts[0] ={transcript: transcript};
        aws.results.items=[];
        aws.status="COMPLETED";
        
        //get the deepspeech transcript
        var ds_transcript = all_metadata.transcripts[0];
        
		//init working variables before processing
		var wordstart =-1;
		var word ="";
                var item=null;
		for (var i = 0; i < ds_transcript.tokens.length; i++) {
		        var thetext=  ds_transcript.tokens[i].text;
				if(wordstart == -1 && thetext==' '){
				   //if we have multiple spaces or the first letter is a space
				   //could happen, not likely though
				   //in this we just continue
				   continue;
				
				//end of transcript
				}else if(i==ds_transcript.tokens.length-1){
                                   var item = {start_time: "0", end_time: "0", type: "pronunciation"};
                                   item.alternatives=[];
                                   item.alternatives[0]={confidence: "1.0", content: ""};

				   if(wordstart==-1){
				     item.start_time = '' + ds_transcript.tokens[i].start_time;
				   }else{
				   	 item.start_time = wordstart;
				   }
				   word = word + thetext;

				   item.end_time = '' + ds_transcript.tokens[i].start_time;
				   item.alternatives[0].content = word;
				   aws.results.items.push(item);
				  
				   
				//found word to be completed   
				} else if(wordstart > -1 && thetext ==' '){
                                   var item = {start_time: "0", end_time: "0", type: "pronunciation"};
                                   item.alternatives=[];
                                   item.alternatives[0]={confidence: "1.0", content: ""};
				   item.start_time = wordstart;
				   item.end_time = '' + ds_transcript.tokens[i].start_time;
				   item.alternatives[0].content = word;
				   aws.results.items.push(item);
				   
				   //reset it all
				   word='';
				   wordstart=-1;
				//perhaps this is the start of a new word   
				} else if(wordstart==-1 && thetext!=' '){
				   wordstart = '' + ds_transcript.tokens[i].start_time;
				    word = word + thetext;
				//add letters to word under construction    
				}else if (thetext!=' '){
				    word = word + thetext;
				}//end of long if
		}//end of loop

 return JSON.stringify(aws);

}//end of function

function bufferToStream(buffer) {
	let stream = new Duplex();
	stream.push(buffer);
	stream.push(null);
	return stream;
}

/*************************************************
    Use sox to convert any audio input to
    mono 16bit PCM 16Khz
    then run DeepSpeech in a stream, a bit hacky
    as other sox libraries are unmaintained

    change sttWithMetadata() to stt() if needed
 **************************************************/

function convertAndTranscribe(model, buffer, inputType) {
	let audioStream = new MemoryStream();
        let soxOpts = {
                        global: {
                                'no-dither': true,
                        },
                        output: {
                                bits: 16,
                                rate: STD_SAMPLE_RATE,
                                channels: 1,
                                encoding: 'signed-integer',
                                endian: 'little',
                                compression: 0.0,
                                type: 'raw'
                        }
                };
        if(inputType != 'auto'){
           soxOpts.input = {type: inputType};
        }
	bufferToStream(buffer).
	pipe(Sox(soxOpts)).
	pipe(audioStream);

	return new Promise(function (resolve, reject) {
		audioStream.on('finish', () => {
			let audioBuffer = audioStream.toBuffer();
			// this is where we run the DeepSpeech model
			let result = model.sttWithMetadata(audioBuffer);
			resolve(result);
		});
	});
}

/*************************************************
    Config of webserver 
    index.ejs from views is used for /
 **************************************************/
app.use(fileUpload({
		createParentPath: true
	}));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
		extended: true
	}));
app.use(morgan('dev'));
app.set("view engine", "ejs");
app.get('/', (req, res) => {
	res.render('index');
});

/*************************************************
    Main method for /transcribe
 takes wav files rom request from browser and returns trancscript
 Called from Browser
 **************************************************/
app.post('/transcribe', async(req, res) => {
	try {
		if (!req.files) {
			res.send({
				status: false,
				message: 'No file uploaded'
			});
		} else {
			console.log("*** start transcribe ***");
			//Use the name of the input field (i.e. "audioFile") to retrieve the uploaded file
            // you may have to change it 
			let audio_input = req.files.audioFile;
			let scorer = req.body.scorer;

			//Use the mv() method to save the file in upload directory (i.e. "uploads")
			var tmpname = Math.random().toString(20).substr(2, 6) + '.wav';
			audio_input.mv('./uploads/' + tmpname);

            // get Length for initial testing
			const audioLength = (audio_input.data.length / 2) * (1 / STD_SAMPLE_RATE);
			console.log('- audio length', audioLength);

			// model creation at this point to be able to switch scorer here
            // we will load diff lang models (Eng. vocab sets) depending on the vocab param
            var usescorer = STD_SCORER;
            if(scorer && scorer!=='none'){
              usescorer = './scorers/id-' + scorer + '.scorer';
              if (!fs.existsSync(usescorer)) {
                  usescorer = STD_SCORER;
              }
             }

			// model creation at this point to be able to switch scorer here
			var model = createModel(STD_MODEL, usescorer);
			// running inference with await to wait for transcription
            var inputType = 'auto';

			//var metadata = await convertAndTranscribe(model, audio_input.data,inputType);
            convertAndTranscribe(model, audio_input.data,inputType).then(function (metadata) {
                // to see metadata uncomment next line
                // console.log(JSON.stringify(metadata, " ", 2));

                var transcription = metadataToString(metadata);
                console.log("Transcription: " + transcription);

                //send response
                res.send({
                    status: true,
                    message: 'File uploaded and transcribed.',
                    data: {
                        transcript: transcription,
                        result: 'success'
                    }
                });

                //delete temp file
                deleteFile('./uploads/' + tmpname);
            }).catch(function (error) {
                console.log(error.message);
                res.status(500).send();
            });

		}
	} catch (err) {
		console.log("ERROR");
		console.log(err);
		res.status(500).send();
	}
});


/*************************************************
    Main method for /s3transcribeReturn
    This version should not block main thread
    Could be made to return resp. to lambda before finish job, if we wanted that.
 Called from SQS->lambda->here
 **************************************************/
app.post('/s3transcribeReturn', (req, res) => {
	try {
		if (!req.body.audioFileUrl) {
	   
				res.send({
						status: false,
						message: 'S3: No file uploaded'
				});
	   
		} else {
				console.log("*** start transcribe ***");

				let transcriptUrl = decodeURIComponent(req.body.transcriptUrl);
				let metadataUrl = decodeURIComponent(req.body.metadataUrl);
				let audioFileUrl = req.body.audioFileUrl;
				let audioFileType = req.body.audioFileType;
				let vocab = req.body.vocab;
				//console.log("transcriptUrl", transcriptUrl);
			    //console.log("metadataUrl", metadataUrl);
				console.log("audioFileUrl", audioFileUrl);
				//console.log("audioFileType", audioFileType);
				console.log("vocab", vocab);
   

				var requestOpts = {method: 'GET', url: audioFileUrl, encoding: null};
				request.get(requestOpts, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                        var audioData = body;
                        const audioLength = (audioData.length / 2) * (1 / STD_SAMPLE_RATE);
                        console.log('- audio length', audioLength);

                        // model creation at this point to be able to switch scorer here
                        // we will load diff lang models (Eng. vocab sets) depending on the vocab param
                        var usescorer = STD_SCORER;
                        if (vocab && vocab !== 'none') {
                            usescorer = './scorers/id-' + vocab + '.scorer';
                            if (!fs.existsSync(usescorer)) {
                                usescorer = STD_SCORER;
                            }
                        }
                        console.log('using scorer:', usescorer);
                        var model = createModel(STD_MODEL, usescorer);

                        var inputType = audioFileType;

                        convertAndTranscribe(model, audioData, inputType)
                            .then(function (metadata) {
                                // console.log(JSON.stringify(metadata, " ", 2));
                                var transcription = metadataToString(metadata);
                                var stringmetadata = metadataToAWSFormat(metadata, transcription);


                                var putTranscriptOpts = {
                                    url: transcriptUrl,
                                    method: 'PUT',
                                    body: transcription,
                                    json: false,
                                    headers: {'Content-Type': 'application/octet-stream'}
                                };
                                request.put(putTranscriptOpts, function (err, res, body) {
                                    if (err) {
                                        console.log('error posting transcript', err);
                                    }
                                    ;
                                });

                                var putMetadataOpts = {
                                    url: metadataUrl,
                                    method: 'PUT',
                                    body: stringmetadata,
                                    json: false,
                                    headers: {'Content-Type': 'application/octet-stream'}
                                };
                                request.put(putMetadataOpts, function (err, res, body) {
                                    if (err) {
                                        console.log('error posting metadata transcript', err);
                                    }
                                });

                                //send response, maybe with some id?
                                res.send({
                                    status: true,
                                    message: 's3transcribeReturn : File uploaded and transcribed .',
                                    data: {
                                        results: "nothing to declare"
                                    }
                                });

                                //END OF THEN
                            }).catch(function (error) {
                                console.log(error.message);
                                res.status(500).send();
                            });

                    }else{
                        console.log("error", error);
                        console.log('response',response);

                    } //end of if error\
                })//end of if req get
        }//end of if audio file url

    } catch (err) {
            console.log("ERROR");
            console.log(err);
            res.status(500).send();
    }
});


/*************************************************
    Main method for /s3transcribe
 synchroneous transcription, ie it blocks thread till returns
 Called from SQS->lambda->here
 **************************************************/
app.post('/s3transcribe', async(req, res) => {
        try {
                if (!req.body.audioFileUrl) {
               
                        res.send({
                                status: false,
                                message: 'S3: No file uploaded'
                        });
               
                } else {
                        console.log("*** start transcribe ***");
                       /* 
                        res.send({
                           status: true,
                           message: req.body.audioFileUrl
                        });
*/
                       

                        //Use the name of the input field (i.e. "audioFile") to retrieve the uploaded file
            // you may have to change it 
                        let transcriptUrl = decodeURIComponent(req.body.transcriptUrl);
                        let metadataUrl = decodeURIComponent(req.body.metadataUrl);
                        let audioFileUrl = req.body.audioFileUrl;
                        let audioFileType = req.body.audioFileType;
                        let vocab = req.body.vocab;
                        console.log("transcriptUrl", transcriptUrl);
                        console.log("metadataUrl", metadataUrl);
                        console.log("audioFileUrl", audioFileUrl);
                        console.log("audioFileType", audioFileType);
                        console.log("vocab", vocab);
            
                        //Use the mv() method to save the file in upload directory (i.e. "uploads")
                       // request(audioFileUrl).pipe(fs.createWriteStream('./uploads/' + audioFilename));

                        var requestOpts = {method: 'GET', url: audioFileUrl, encoding: null};
                        request.get(requestOpts, async function (error, response, body) {
                           if (!error && response.statusCode == 200) {
                              var audioData = body;
                              const audioLength = (audioData.length / 2) * (1 / STD_SAMPLE_RATE);
                              console.log('- audio length', audioLength);

                              // model creation at this point to be able to switch scorer here
                              // we will load diff lang models (Eng. vocab sets) depending on the vocab param
                              var usescorer = STD_SCORER;
                              if(vocab && vocab!=='none'){
                                 usescorer = './scorers/id-' + vocab + '.scorer';
                                 if (!fs.existsSync(usescorer)) {
                                   usescorer = STD_SCORER;
                                 }
                              }
                              console.log('using scorer:', usescorer);
                              var model = createModel(STD_MODEL,usescorer);
                              // running inference with await to wait for transcription
                              var inputType = audioFileType;
                              var metadata = await convertAndTranscribe(model, audioData,inputType);
                        
                             // to see metadata uncomment next line
                             // console.log(JSON.stringify(metadata, " ", 2));
            
                             var transcription = metadataToString(metadata);
                             var stringmetadata = metadataToAWSFormat(metadata,transcription);
                             //old string metadata
                             //var stringmetadata = JSON.stringify(metadata);

                             console.log("Transcription: " + transcription);
                             //console.log("Transcription META: " + stringmetadata);
                             
                             var putTranscriptOpts={ url: transcriptUrl, 
                                  method: 'PUT', 
                                  body: transcription,
                                  json: false,
                                  headers: {'Content-Type': 'application/octet-stream'}
                             };
                             request.put(putTranscriptOpts,function(err,res,body){
                               if(err){
                                 console.log('error posting transcript',err);
                               }
                               //console.log('res',res);
                              // console.log('body',body);
                             });

                             var putMetadataOpts={ url: metadataUrl, 
                                  method: 'PUT', 
                                  body: stringmetadata,
                                  json: false,
                                  headers: {'Content-Type': 'application/octet-stream'}
                             };
                             request.put(putMetadataOpts,function(err,res,body){
                               if(err){
                                 console.log('error posting metadata transcript',err);
                               }
                               //console.log('res',res);
                              // console.log('body',body);
                             });


                              //send response
                              res.send({
                                      status: true,
                                      message: 'File uploaded and transcribed.',
                                      data: {
                                        results: transcription
                                      }
                              });

                           }else{
                              console.log("error", error);
                              console.log('response',response);

                           } //end of if error
                        }); ////end of request get

                } //End of if rew.body
        } catch (err) {
                console.log("ERROR");
                console.log(err);
                res.status(500).send();
        }
});

/*************************************************
    Trigger building a new language model with KenLM
   ONE AT A TIME : concurrent use is NOT safe
 Called from SQS->lambda->here
 **************************************************/
 
const execFile = require('child_process').execFile;
const path2buildDir = "/home/scorerbuilder/"

function moveFile(fromPath, toPath) {
    fs.rename(fromPath, toPath, (err) => {
      if (err) throw err;
      console.log('Move complete ' + toPath);
    });
}

function deleteFile(path) {
    try{
     fs.unlinkSync(path);
    }catch(err){
     console.log(err);
    }
}

function write2File (path, content) {
    fs.appendFile(path, content, function (err) {
       if (err) return console.log(err);
       console.log('File written');
    });
}

app.get('/scorerbuilder', (req, res) => {
    var sentence = req.query.sentence;
    console.log("** Build Scorer for " + sentence);
    
    deleteFile(path2buildDir + "mini-new-sentence.txt");
    write2File(path2buildDir + "mini-new-sentence.txt", sentence + "\n");
    
    // create new unique id
    const hash = crypto.createHash('sha1');
    hash.update(sentence);
    var uid = 'id-' + hash.digest('hex');
    var pathtoscorer = "./scorers/" + uid + ".scorer";
    var pathtotext = "./scorers/" + uid + ".txt";
    if (fs.existsSync(pathtoscorer)) {
        console.log("** Scorer already existed **");
        res.send({
           status: true,
           message: 'Scorer already existed',
           data: {scorerID: uid}
        });
        return;
    }else{
    
        // run script that builds model, callback after that is done and we moved scorer
	const child = execFile(path2buildDir + "mini-build-special-lm.sh", [], (error, stdout, stderr) => {
        if (error) {
            console.error('stderr', stderr);
            throw error;
        }
        console.log('stdout', stdout);
        
        // script is done, scorer is built, mv scorer and txt
        moveFile(path2buildDir + "scorer", pathtoscorer);
        moveFile(path2buildDir + "mini-lm.txt", pathtotext);

        //send response
        res.send({
            status: true,
            message: 'Scorer generated with given id below',
            data: {
                scorerID: uid
            }
        });//end of res send
      });//end of execfile
    }//end of if pathtoscorer  exists
    
});//end of app.get

/*************************************************
 SpellCheck Something
 Called from SQS->lambda->here OR browser

 **************************************************/
const SpellChecker = require('node-aspell');

app.post('/spellcheck',(req,res)=>{
    try {
        if (!req.body.passage) {

            res.send({
                status: false,
                message: 'spellcheck: No passage included'
            });

        } else {
            console.log("*** start spellcheck ***");

            let lang= req.body.lang; //eg "en_US"
            let passage = req.body.passage;
            let vocab = req.body.vocab;

            const checker = new SpellChecker.Spellchecker(lang);
            let words = passage.split(' ');
            let returndata={};
            returndata.results =[];
            for(var i=0;i<words.length;i++){
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
 Main method for /convertMedia to mp3 ot mp4 with ffmpeg
 which returns after upload and saves result async
 Called from SQS->lambda->here UNTESTED
 **************************************************/

function downloadmedia(downloadurl, savepath, callback){
    request.head(downloadurl, (err, res, body) => {
        request(downloadurl)
            .pipe(fs.createWriteStream(savepath))
            .on('close', callback)
    });
}
app.post('/convertMediaReturn', (req, res) => {
    try {
        if (!req.body.sourceUrl) {

            res.send({
                status: false,
                message: 'convertMediaReturn: No file URL received'
            });

        } else {
            console.log("*** start convert ***");

            let destinationUrl = decodeURIComponent(req.body.destinationUrl);
            let sourceUrl = decodeURIComponent(req.body.sourceUrl);
            let mediaType = req.body.mediaType;
            let format ="mp3";
            let tmpfilename = Math.random().toString(20).substr(2, 6);
            if(mediaType=='audio') {
                tmpfilename += '.mp3';
                format ="mp3";
            }else{
                tmpfilename += '.mp4';
                format ="mp4";
            }
            let convfilename ='conv_' + tmpfilename;
            let ffmpegfolder ='./ffmpegwork/';
            console.log("destinationUrl ", destinationUrl );
            console.log("sourceUrl ", sourceUrl );
            console.log("mediaType", mediaType);

            //alternative download way
            //or request(audioFileUrl).pipe(fs.createWriteStream('./uploads/' + audioFilename));

            //download then convert then delete.
            //NB return is not waiting for processing to finish.
            downloadmedia(sourceUrl,ffmpegfolder + tmpfilename,function () {
                var proc = ffmpeg(ffmpegfolder + tmpfilename)
                    .format(format)
                    // setup event handlers
                    .on('end', function() {
                        console.log('file has been converted succesfully');
                        var putDestinationOpts = {
                            url: destinationUrl,
                            method: 'PUT',
                            body: fs.createReadStream(ffmpegfolder + convfilename),
                            json: false,
                            headers: {'Content-Type': 'application/octet-stream'}
                        };
                        request.put(putDestinationOpts, function (err, res, body) {
                            if (err) {
                                console.log('error posting converted file', err);
                            }
                            //clean up
                            deleteFile(ffmpegfolder + convfilename);
                            deleteFile(ffmpegfolder + tmpfilename);
                        });

                    })
                    .on('error', function(err) {
                        console.log('an error happened: ' + err.message);
                    })
                    // save to file
                    .save(ffmpegfolder + convfilename);

             });

            //send response, maybe with some id?
            res.send({
                status: true,
                message: 'convertMediaReturn : File conversion job started.',
                data: {
                    results: "nothing to declare"
                }
            });

        }//end of if sourceurl

    } catch (err) {
        console.log("ERROR");
        console.log(err);
        res.status(500).send();
    }
});


/*************************************************
 Main method for /stt.php
 takes wav files + model from returns trancscript
 Called from TTD server/browser
 **************************************************/
app.post('/stt.php', async(req, res) => {
    try {
        if (!req.files) {
            res.send({
                status: false,
                message: 'No file uploaded'
            });
        } else {
            console.log("*** start ttd transcribe ***");
            //retrieve audio and scorer
            let audio_input = req.files.blob;
            let scorer = req.files.scorer;
            let audiotype = req.body.audiotype;
            let tmpname = Math.random().toString(20).substr(2, 6);
            let scorerpath ='./uploads/'+  tmpname + '.scorer';
            console.log('audiotype:',audiotype);

            //Use the mv() method to save the scorer in upload directory (i.e. "uploads")
            //we need to wait for it to finish or the next steps dont work
           await scorer.mv(scorerpath);
           //console.log('using scorer:',scorerpath);


            // model creation at this point to be able to switch scorer here
            var model = createModel(STD_MODEL, scorerpath);

            // audiotype could be wav/webm/mp3 or auto
            //auto will not work for mp3 though, so best to be specific
            var inputType = 'mp3';
            if ( typeof audiotype !== 'undefined' && audiotype ){
                inputType=audiotype;
            }


           // convertAndTranscribe(model, audio_input.data,inputType).then(function (metadata) {
           convertAndTranscribe(model, audio_input.data,inputType).then(function (metadata) {
                // to see metadata uncomment next line
                // console.log(JSON.stringify(metadata, " ", 2));

                var transcription = metadataToString(metadata);
                console.log("Transcription: " + transcription);

                //send response
                res.send({
                    status: true,
                    message: 'File transcribed.',
                    data: {
                        transcript: transcription,
                        result: 'success'
                    }
                });

                //delete temp files
                deleteFile(scorerpath);
            }).catch(function (error) {
                console.log(error.message);
                res.status(500).send();
            });

        }
    } catch (err) {
        console.log("ERROR");
        console.log(err);
        res.status(500).send();
    }
});

/*************************************************
 Main method for /lm.php
 returns scorer for set of words and saves the scorer and text
 concurrent use is safe
 Called from TTD server/browser
 **************************************************/
app.post('/lm.php', (req, res) => {
    var text = req.body.text;
    console.log("** Build Scorer for " + text);

    // create new unique id
    const hash = crypto.createHash('sha1');
    hash.update(text);
    var uid = 'id-' + hash.digest('hex');
    var pathtoscorer = "./scorers/" + uid + ".scorer";
    var pathtotext = "./scorers/" + uid + ".txt";
    if (fs.existsSync(pathtoscorer)) {
        console.log("** Scorer already existed **");
        fs.readFile(pathtoscorer, function(err,data)
        {
            if(err) {
                console.log(err)
            }else {
                let buff = new Buffer(data);
                let base64data = buff.toString('base64');

                //send response
                res.send({
                    status: true,
                    message: 'Scorer fetched',
                    data: base64data
                });//end of res send
            }
            return;
        });

    }else{

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

            fs.readFile(tmp_scorerpath, function(err,data)
            {
                if(err) {
                    console.log(err)
                }else {
                    let buff = new Buffer(data);
                    let base64data = buff.toString('base64');

                    //send response
                    res.send({
                        status: true,
                        message: 'Scorer generated',
                        data: base64data
                    });//end of res send

                    // script is done, scorer is built, mv scorer and txt
                    moveFile(tmp_scorerpath, pathtoscorer);
                    moveFile(tmp_textpath, pathtotext);
                }
            });

        });//end of execfile
    }//end of if pathtoscorer  exists

});//end of app.get

/*************************************************
    Start Webserver and run the file
    index.ejs from views for / call
 **************************************************/
const port = process.env.PORT || 3000;
// HTTPS options, paths are given by let's encrypt certbot
var options = {
 // key: fs.readFileSync('/etc/letsencrypt/live/dstokyo.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dstokyo.poodll.com/fullchain.pem')
 // key: fs.readFileSync('/etc/letsencrypt/live/dsuseast.poodll.com/privkey.pem'),
  //cert: fs.readFileSync('/etc/letsencrypt/live/dsuseast.poodll.com/fullchain.pem')
  // key: fs.readFileSync('/etc/letsencrypt/live/dssydney.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dssydney.poodll.com/fullchain.pem')
 // key: fs.readFileSync('/etc/letsencrypt/live/dsdublin.poodll.com/privkey.pem'),
 // cert: fs.readFileSync('/etc/letsencrypt/live/dsdublin.poodll.com/fullchain.pem')
};

//for HTTP choose a cert and key and use line below
//var server = https.createServer(options, app);

//for http comment out all cert optons (or leave them?) and server line
var server = http.createServer(options, app);

server.listen(port, () =>
	console.log(`App is listening on port ${port}.`));
    

