import './styles.css';

export * from './core/types';
export { InteractionController, type ControllerEvents } from './core/InteractionController';
export { LookTracker } from './core/LookTracker';
export { inShape, pickZone } from './core/hitTest';
export type { CharacterRenderer } from './render/CharacterRenderer';
export { LayeredRenderer, type LayeredModel, type LayerDef, type ClipDef, type FollowWeights } from './render/LayeredRenderer';
export { SpineRenderer, type SpineModel, type SpineGestureRig } from './render/SpineRenderer';
export { sampleTrack, type Keyframe, type LayerTransform, type Ease } from './render/clip';
export { DialogueBox, type DialogueOptions, type SayOptions } from './ui/DialogueBox';
export { BackgroundLayer, type BackgroundLayerDef } from './scene/BackgroundLayer';
export { CharacterStage, type StageOptions } from './scene/CharacterStage';
export { AgentDirector, type AgentDirectorOptions, type AgentDirectorEvents, type DialogueLike, type DirectedRenderer } from './agent/AgentDirector';
export { playAudio, unlockAudio, audioContext, type AudioPlayback, type AudioPlayerFactory } from './agent/audio';
export { connectAgentSocket, type ServerMessage, type ClientMessage, type SocketLike, type BridgeTarget } from './agent/socketBridge';
export type { AgentEvent, AgentEventResult, AudioInput } from './agent/types';
