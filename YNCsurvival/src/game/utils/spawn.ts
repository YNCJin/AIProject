import { WORLD_SIZE } from '../config';

//  플레이어 기준 화면 바로 바깥의 원 위 랜덤 위치 (월드 경계 안으로 보정)
export function pointAroundPlayer (scene: Phaser.Scene, player: { x: number; y: number }, extra = 40)
{
    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const distance = Math.hypot(scene.scale.width, scene.scale.height) / 2 + extra;
    return {
        x: Phaser.Math.Clamp(player.x + Math.cos(angle) * distance, 0, WORLD_SIZE),
        y: Phaser.Math.Clamp(player.y + Math.sin(angle) * distance, 0, WORLD_SIZE)
    };
}
