import Error from '../error/error'
import * as Utils from '../utils/util'
import {Parser, StringDecoder} from './text-track-display'
import {TrackType} from "./track-type";
import TextTrack from "./text-track";
import {CustomEventType, Html5EventType} from "../event/event-type";
import FakeEvent from "../event/fake-event";
import getLogger from "../utils/logger";

class ExternalCaptionsHandler {

  static VTT_POSTFIX: string = 'vtt';

  static SRT_POSTFIX: string = 'srt';
  /**
   * The player class logger.
   * @type {any}
   * @static
   * @private
   */
  static _logger: any = getLogger('External captions handler');
  /**
   * Index that specifies the last cue that is playing / played in the text track cue array.
   * @type {number}
   * @private
   */
  _externalCueIndex: number = 0;
  /**
   * a callback of the timeupdate, for external captions handler.
   * @type {Function}
   * @private
   */
  _handleExternalCaptionsCallback: Function = null;
  /**
   * flag that indicates the use of native text tracks
   * @type {boolean}
   * @private
   */
  _useNativeTextTracks: boolean = false;
  /**
   * the video element, used for native tracks.
   * @type {HTMLVideoElement}
   * @private
   */
  _videoElement: HTMLVideoElement = null;
  /**
   * the player object.
   * @type {Object}
   * @private
   */
  _player: null;

  /**
   * constructor
   * @param {HTMLVideoElement} videoElement - video element.
   * @param {Object} player - the player object.
   */
  constructor(videoElement: HTMLVideoElement, player: Object) {
    this._player = player;
    this._videoElement = videoElement;
  }

  /**
   * Make a request to download a caption and parse it's content to cues.
   * @param {string} url - url for the captions file.
   * @returns {Promise<any>} - resolves when the request returns and the caption string is parsed to cues.
   * @private
   */
  _getCuesArray(url: string): Promise<*> {
    return new Promise((resolve, reject) => {
      Utils.Http.execute(url, {}, 'GET').then(response => {
        switch (this._getFileType(url)) {
          case ExternalCaptionsHandler.VTT_POSTFIX:
            this._parseCues(response, resolve);
            break;
          case ExternalCaptionsHandler.SRT_POSTFIX:
            response = this._convertSrtToVtt(response);
            this._parseCues(response, resolve);
            break;
        }
      }).catch(error => {
        reject(new Error(Error.Severity.RECOVERABLE, Error.Category.TEXT, Error.Code.HTTP_ERROR, error.payload));
      })
    });
  }

  /**
   * this calls the VTTCue parser and parse the .vtt captions string into vttCues objects
   * @param {string} vttStr - a string in a .vtt format to parse into VTTCues
   * @param {Function} resolve - a resolve function of the calling function.
   * @returns {void}
   * @private
   */
  _parseCues(vttStr: string, resolve: Function): void {
    const parser = new Parser(window, StringDecoder());
    let cues = [];
    parser.oncue = cue => {
      cues.push(cue);
    };
    parser.onflush = () => {
      ExternalCaptionsHandler._logger.debug('finished parsing external cues');
      resolve(cues);
    };
    parser.parse(vttStr);
    parser.flush();
  }

  /**
   * converts a .SRT string into .VTT string
   * @param {string} str - a string in a .SRT format
   * @returns {string} - a string in a .VTT format
   * @private
   */
  _convertSrtToVtt(str: string): string {
    return str.replace(/(\d\d:\d\d:\d\d).(\d\d\d) --> (\d\d:\d\d:\d\d).(\d\d\d)/g, (match, part1, part2, part3, part4) => {
      return `${part1},${part2} --> ${part3},${part4}`;
    });
  }

  /**
   * create caption object for each of the captions.
   * @param {Array<Object>} captions - the captions config from the player config.
   * @returns {Promise<any>} resolves when all the captions are parsed.
   * @private
   */
  _createCaptions(captions: Array<Object>): Promise<*> {
    return new Promise((resolve) => {
      let promiseArr = [];

      captions.forEach((caption) => {
        promiseArr.push(this._createCaption(caption));
      });

      return Promise.all(promiseArr).then(tracks => {
        resolve(tracks);
      });
    });
  }

  /**
   * resolves with a caption object that contains all the caption data
   * start the parsing, creation and addition of the external captions.
   * @param {object} caption - the caption configuration from the player config.
   * @returns {Promise<any>} - the caption object with the parsed cues
   * @private
   */
  _createCaption(caption: Object): Promise<*> {
    return new Promise((resolve) => {
      this._getCuesArray(caption.url)
        .then(cues => {
          resolve({
            label: caption.label,
            language: caption.language,
            isDefault: caption.default,
            cues: cues
          })
        });
    });
  }

  /**
   * this function runs on the players text tracks and checks if there is already a text track with the same language
   * as the new one.
   * @param {Object} caption - the caption to check
   * @returns {number} - the index of the text track with the same language (if there is any). and -1 if there isn't
   * @private
   */
  _indexOfSameLanguageTrack(caption: object): number {
    const trackList = this._videoElement.textTracks;
    let index = -1;
    for (let i = 0; i < trackList.length; i++) {
      if (trackList[i].language === caption.language) {
        index = i;
        break;
      }
    }
    return index;
  }

  /**
   * this function creates and adds a text track to the video element, incase there is a need in using
   * native text tracks instead of using the player external text module.
   * @param {Array<any>} captions - array of captions to add.
   * @returns {void}
   * @private
   */
  _createNativeTextTrack(captions: Array<any>): void {
    captions.forEach(caption => {
      let track;
      const sameLanguageTrackIndex = this._indexOfSameLanguageTrack(caption);
      if (sameLanguageTrackIndex > -1) {
        track = this._videoElement.textTracks[sameLanguageTrackIndex];
        track.mode = 'hidden';
        if (track.cues) {
          Object.values(track.cues).forEach(cue => {
            track.removeCue(cue);
          });
        }
      } else {
        track = this._videoElement.addTextTrack("captions", caption.label, caption.language);
      }
      caption.cues.forEach(cue => {
        track.addCue(cue);
      });
    });
  }

  /**
   * getting the file extension
   * @param {string} url - the url of the file
   * @returns {string} type of the file
   * @private
   */
  _getFileType(url: string): string {
    return url.split(/\#|\?/)[0].split('.').pop().trim();
  }


  /**
   * callback for the 'timeupdate' event. on each time update this runs and checks if the active text cues array
   * was changed.
   * @param {TextTrack} track - the text track that that is currently displayed (active)
   * @returns {void}
   * @private
   */
  _handleCaptionOnTimeUpdate(track: TextTrack): void {
    if (this._player._activeTextCues.length > 0 && this._player.currentTime < this._player._activeTextCues[this._player._activeTextCues.length - 1].startTime) {
      this._player._activeTextCues = [];
      this._player._onCueChange({
        payload: {
          cues: []
        }
      });
    } else {
      let _activeCuesChanged = false;
      for (let _activeTextCuesIndex = 0; _activeTextCuesIndex < this._player._activeTextCues.length; _activeTextCuesIndex++) {
        let _cue = this._player._activeTextCues[_activeTextCuesIndex];
        if (this._player.currentTime < _cue.startTime || _cue.endTime < this._player.currentTime) {
          this._player._activeTextCues.splice(_activeTextCuesIndex, 1);
          _activeCuesChanged = true;
        }
      }
      while (this._player.currentTime > track.cues[this._externalCueIndex].startTime) {
        this._player._activeTextCues.push(track.cues[this._externalCueIndex]);
        this._externalCueIndex++;
        _activeCuesChanged = true;
      }
      if (_activeCuesChanged) {
        this._player._onCueChange({
          payload: {
            cues: this._player._activeTextCues
          }
        });
      }
    }
  }

  /**
   * updating the index of the text cues to the right location after a user seeked.
   * @returns {void}
   * @private
   */
  _maybeSetExternalCueIndex(): void {
    const textTrack = this._player._getTracksByType(TrackType.TEXT).filter(track => {
      track.active() && track.external;
    });
    if (textTrack) {
      let cues = textTrack.cues;
      for (let i = 0; i < cues.length; i++) {
        if (this._player.currentTime < cues[i].startTime) {
          this._externalCueIndex = i;
        } else {
          break;
        }
      }
    }
  }

  /**
   * adding external tracks (native or moduled tracks)
   * @returns {Promise<any>} returns a promise when all the tracks were parsed and added.
   * @public
   */
  addExternalTracks(): Promise<*> {
    return new Promise((resolve) => {
      const captions = this._player._config.sources.captions;
      if (!captions) {
        resolve();
      }
      this._createCaptions(captions.tracks).then((parsedCaptions) => {
        let textTracks = this._player._getTracksByType(TrackType.TEXT);
        let textTracksLength = textTracks.length || 0;
        parsedCaptions.forEach(caption => {
          let track = new TextTrack({
            active: false,
            index: textTracksLength++,
            kind: "subtitles",
            label: caption.label,
            language: caption.language,
            external: true,
            cues: caption.cues
          });
          let sameLangTrack = textTracks.filter(textTrack => caption.language === textTrack.language);
          if (sameLangTrack.length) {
            track.index = sameLangTrack[0].index;
            sameLangTrack[0] = track;
          } else {
            this._player._tracks.push(track);
          }
        });
        if (this._useNativeTextTracks) {
          this._createNativeTextTrack(captions);
        }
        resolve();
      })
    })
  }

  /**
   * selects external track start listenning to cues
   * @param {TextTrack} textTrack - selected text track
   * @returns {void}
   * @public
   */
  selectExternalTextTrack(textTrack: TextTrack): void {
    const track = this._player._getTracksByType(TrackType.TEXT).filter(track => {
      if (track.index !== textTrack.index) {
        track.active = false;
      } else {
        return true;
      }
    })[0];
    if (!track.active) {
      this._player._engine.disableAllTextTracks();
      ExternalCaptionsHandler._logger.debug('External text track changed', track);
      track.active = true;
      this._player.dispatchEvent(new FakeEvent(CustomEventType.TEXT_TRACK_CHANGED, {selectedTextTrack: track}));
      this._handleExternalCaptionsCallback = () => {
        this._handleCaptionOnTimeUpdate(track);
      };
      this._player._engine.addEventListener(Html5EventType.TIME_UPDATE, this._handleExternalCaptionsCallback);
    }
  }
}

export default ExternalCaptionsHandler;