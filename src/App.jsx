import React, { useState, useRef } from 'react';
    import JSZip from 'jszip';

    function App() {
      const [audioFile, setAudioFile] = useState(null);
      const [startTime, setStartTime] = useState('');
      const [endTime, setEndTime] = useState('');
      const [segments, setSegments] = useState('');
      const [errorMessage, setErrorMessage] = useState('');
      const [processing, setProcessing] = useState(false);
      const [downloading, setDownloading] = useState(false);
      const audioRef = useRef(null);

      const handleFileChange = (event) => {
        const file = event.target.files[0];
        setAudioFile(file);
        setErrorMessage('');
      };

      const handleSegment = async () => {
        if (!audioFile) {
          setErrorMessage('Please upload an audio file.');
          return;
        }

        const start = parseFloat(startTime);
        const end = parseFloat(endTime);
        const numSegments = parseInt(segments);

        if (isNaN(start) && isNaN(end) && isNaN(numSegments)) {
          setErrorMessage('Please provide either start/end times or number of segments.');
          return;
        }

        if ((!isNaN(start) || !isNaN(end)) && !isNaN(numSegments)) {
          setErrorMessage('Please provide either start/end times or number of segments, not both.');
          return;
        }

        if (!isNaN(start) && !isNaN(end)) {
          if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
            setErrorMessage('Invalid start or end time.');
            return;
          }
        }

        if (!isNaN(numSegments) && numSegments <= 0) {
          setErrorMessage('Number of segments must be greater than 0.');
          return;
        }

        setProcessing(true);
        setErrorMessage('');

        try {
          const audioContext = new AudioContext();
          const fileReader = new FileReader();

          fileReader.onload = async (event) => {
            const arrayBuffer = event.target.result;
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const sampleRate = audioBuffer.sampleRate;

            if (!isNaN(numSegments)) {
              const segmentDuration = audioBuffer.duration / numSegments;
              const segmentPromises = [];

              for (let i = 0; i < numSegments; i++) {
                const start = i * segmentDuration;
                const end = (i + 1) * segmentDuration;
                segmentPromises.push(
                  processSegment(audioBuffer, start, end, sampleRate, audioContext, i)
                );
              }
              const mp3Blobs = await Promise.all(segmentPromises);
              downloadSegments(mp3Blobs, audioFile.name);
            } else {
              const startSample = Math.round(start * sampleRate);
              const endSample = Math.round(end * sampleRate);
              const segmentLength = endSample - startSample;

              if (segmentLength <= 0 || endSample > audioBuffer.length) {
                setErrorMessage('Invalid segment range.');
                setProcessing(false);
                return;
              }

              const segmentBuffer = audioContext.createBuffer(
                audioBuffer.numberOfChannels,
                segmentLength,
                sampleRate
              );

              for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
                const sourceData = audioBuffer.getChannelData(channel);
                const targetData = segmentBuffer.getChannelData(channel);
                for (let i = 0; i < segmentLength; i++) {
                  targetData[i] = sourceData[startSample + i];
                }
              }

              const mp3Blob = await encodeToMp3(segmentBuffer, sampleRate);
              downloadSegment(mp3Blob, audioFile.name, start, end);
            }
            setProcessing(false);
          };

          fileReader.readAsArrayBuffer(audioFile);
        } catch (error) {
          setErrorMessage('Error processing audio: ' + error.message);
          setProcessing(false);
        }
      };

      const processSegment = async (audioBuffer, start, end, sampleRate, audioContext, index) => {
        const startSample = Math.round(start * sampleRate);
        const endSample = Math.round(end * sampleRate);
        const segmentLength = endSample - startSample;

        const segmentBuffer = audioContext.createBuffer(
          audioBuffer.numberOfChannels,
          segmentLength,
          sampleRate
        );

        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          const sourceData = audioBuffer.getChannelData(channel);
          const targetData = segmentBuffer.getChannelData(channel);
          for (let i = 0; i < segmentLength; i++) {
            targetData[i] = sourceData[startSample + i];
          }
        }

        const mp3Blob = await encodeToMp3(segmentBuffer, sampleRate);
        return { blob: mp3Blob, start, end, index };
      };

      const encodeToMp3 = async (audioBuffer, sampleRate) => {
        const offlineContext = new OfflineAudioContext(
          audioBuffer.numberOfChannels,
          audioBuffer.length,
          sampleRate
        );
        const source = offlineContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineContext.destination);
        source.start();

        const renderedBuffer = await offlineContext.startRendering();
        const wavData = bufferToWav(renderedBuffer);
        const mp3Blob = await convertWavToMp3(wavData);
        return mp3Blob;
      };

      const bufferToWav = (buffer) => {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const numSamples = buffer.length;
        const bytesPerSample = 2;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = numSamples * blockAlign;

        const bufferSize = 44 + dataSize;
        const wavBuffer = new ArrayBuffer(bufferSize);
        const view = new DataView(wavBuffer);

        // RIFF identifier
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(view, 8, 'WAVE');

        // fmt chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);

        // data chunk
        writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        floatTo16BitPCM(view, 44, buffer);

        return wavBuffer;
      };

      const floatTo16BitPCM = (output, offset, input) => {
        for (let i = 0; i < input.length; i++, offset += 2) {
          const s = Math.max(-1, Math.min(1, input.getChannelData(0)[i]));
          output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
      };

      const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      };

      const convertWavToMp3 = async (wavData) => {
        const wavBlob = new Blob([wavData], { type: 'audio/wav' });
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            const buffer = event.target.result;
            const mp3Blob = new Blob([buffer], { type: 'audio/mpeg' });
            resolve(mp3Blob);
          };
          reader.readAsArrayBuffer(wavBlob);
        });
      };

      const downloadSegment = async (mp3Blob, fileName, start, end) => {
        setDownloading(true);
        const zip = new JSZip();
        const segmentName = `${fileName.split('.')[0]}_${start}-${end}.mp3`;
        zip.file(segmentName, mp3Blob);

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'segments.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setDownloading(false);
      };

      const downloadSegments = async (segments, fileName) => {
        setDownloading(true);
        const zip = new JSZip();
        segments.forEach(({ blob, start, end, index }) => {
          const segmentName = `${fileName.split('.')[0]}_${index + 1}.mp3`;
          zip.file(segmentName, blob);
        });

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'segments.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setDownloading(false);
      };

      return (
        <div className="app-container">
          <h1>Audio Splitter</h1>
          <input type="file" accept="audio/*" onChange={handleFileChange} />
          <div className="segment-controls">
            <input
              type="number"
              placeholder="Start Time (s)"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
            <input
              type="number"
              placeholder="End Time (s)"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
            <input
              type="number"
              placeholder="Segments"
              value={segments}
              onChange={(e) => setSegments(e.target.value)}
            />
          </div>
          <button onClick={handleSegment} disabled={processing || downloading}>
            Split Audio
          </button>
          {errorMessage && <p className="error-message">{errorMessage}</p>}
          {processing && <p className="processing-message">Processing...</p>}
          {downloading && <p className="processing-message">Downloading...</p>}
        </div>
      );
    }

    export default App;
