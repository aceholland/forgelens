const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
exports.render = output => {
  const evidencePath = path.join(output, 'evidence.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  if (!evidence.scenes?.length || evidence.trueforgeRequests !== 0 || evidence.stagedChanges !== false) throw new Error('Verified UI evidence is required before narration');
  const clips = [];
  for (const [index, scene] of evidence.scenes.entries()) {
    const audio = path.join(output, `voice-${index}.wav`), clip = path.join(output, `scene-${index}.mp4`);
    const title = index === 0 ? 'SUPPLEMENTAL - LOCAL PREVIEW - NO MODEL INFERENCE' : 'ForgeLens 0.2.0 | Context preview';
    execFileSync('espeak', ['-v', 'en-us', '-s', '155', '-w', audio, scene.narration], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(output, scene.image), '-i', audio,
      '-vf', `pad=ceil(iw/2)*2:ceil(ih/2)*2,drawbox=x=0:y=0:w=iw:h=45:color=black@0.85:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='${title}':fontcolor=white:fontsize=22:x=20:y=10`,
      '-af', 'apad=pad_dur=0.7', '-c:v', 'libx264', '-preset', 'fast', '-tune', 'stillimage', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-shortest', clip], { stdio: 'pipe' });
    clips.push(clip);
  }
  const list = path.join(output, 'scenes.txt');
  fs.writeFileSync(list, clips.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  const video = path.join(output, 'ForgeLens-0.2.0-preview.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video], { stdio: 'pipe' });
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', video], { encoding: 'utf8' }));
  execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], { stdio: 'pipe' });
  evidence.video = { file: path.basename(video), bytes: fs.statSync(video).size, sha256: createHash('sha256').update(fs.readFileSync(video)).digest('hex'), durationSeconds: Number(probe.format.duration), codec: probe.streams.find(stream => stream.codec_type === 'video')?.codec_name, width: probe.streams[0].width, height: probe.streams[0].height, narration: 'Local espeak TTS; no paid model or voice service', decodeCheck: 'passed' };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  // Keep only final media, genuine screenshots, narration and evidence in the artifact.
  for (let index = 0; index < clips.length; index++) { fs.unlinkSync(clips[index]); fs.unlinkSync(path.join(output, `voice-${index}.wav`)); }
  fs.unlinkSync(list);
  console.log(JSON.stringify(evidence.video));
};
