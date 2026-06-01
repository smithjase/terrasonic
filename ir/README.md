# Impulse Response Files

Place real IR files here for convolution reverb. Download free, high-quality IRs from:

- **OpenAIR** — https://www.openair.hosted.york.ac.uk/
- **EchoThief** — http://www.echothief.com/downloads/

## Required Files

| Filename | Description |
|---|---|
| `hall.wav` | Large concert hall — used for "vast" space setting |
| `plate.wav` | Plate reverb — used for "intimate" space setting |
| `chamber.wav` | Chamber reverb — used for mid-range space |

## Notes

- Mono or stereo WAV files work.
- Recommended: 44100 Hz or 48000 Hz sample rate.
- If any file is missing or fails to load, the engine will automatically fall back to a synthetic convolution reverb generated from a filtered noise burst. The app works perfectly without these files.
