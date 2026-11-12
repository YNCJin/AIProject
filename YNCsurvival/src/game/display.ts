//  화면 해상도 관리
//  - 게임 안의 모든 좌표와 배치는 GAME_WIDTH x GAME_HEIGHT(1024x768) 기준으로 쓴다
//  - 실제 캔버스는 브라우저 창 크기 x 디스플레이 배율(125%, 150% ...)에 맞춰 RENDER_SCALE 배로 크게 그리고,
//    각 씬의 카메라를 RENDER_SCALE 배 확대해서 맞춘다 -> 늘려서 흐려지는 일 없이 선명하게 보임
//  - 그림(art/Textures.ts)은 ART_SCALE 배 크기로 그려 두고 화면에는 1/ART_SCALE 로 줄여서 표시

export const GAME_WIDTH = 1024;
export const GAME_HEIGHT = 768;
export const SCREEN = { width: GAME_WIDTH, height: GAME_HEIGHT };

const MAX_RENDER_SCALE = 2.5;   //  너무 큰 캔버스는 느려지므로 상한

function computeRenderScale (): number
{
    if (typeof window === 'undefined')
    {
        return 1;
    }
    const fit = Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
    //  모듈이 읽히는 시점에는 Phaser 전역이 아직 없을 수 있어서 직접 계산
    const scale = Math.min(MAX_RENDER_SCALE, Math.max(1, fit * (window.devicePixelRatio || 1)));
    return Math.round(GAME_WIDTH * scale) / GAME_WIDTH;     //  캔버스 크기가 정수가 되도록
}

export const RENDER_SCALE = computeRenderScale();
export const CANVAS_WIDTH = Math.round(GAME_WIDTH * RENDER_SCALE);
export const CANVAS_HEIGHT = Math.round(GAME_HEIGHT * RENDER_SCALE);

//  글자를 그리는 해상도 (카메라 확대 배율보다 작으면 흐려짐)
export const TEXT_RESOLUTION = Math.ceil(RENDER_SCALE);

//  코드로 그리는 그림의 해상도 배율
export const ART_SCALE = 2;

//  그림 텍스처를 쓰는 오브젝트의 표시 배율 (예: artScale(1.3) = 원래 크기의 1.3배)
export function artScale (scale = 1): number
{
    return scale / ART_SCALE;
}

//  모든 씬에서 create() 시작 시 호출: 좌표 1024x768 을 실제 캔버스 크기로 확대
export function setupCamera (scene: Phaser.Scene)
{
    scene.cameras.main.setOrigin(0, 0).setZoom(RENDER_SCALE);
}

//  카메라가 target 을 화면 정중앙에 두고 따라가게 함 (소수점 위치도 그대로 -> 부드러운 이동)
export function followCamera (scene: Phaser.Scene, target: Phaser.GameObjects.GameObject)
{
    scene.cameras.main.startFollow(target, false)
        .setFollowOffset(GAME_WIDTH / 2, GAME_HEIGHT / 2);
}

//  지금 화면에 보이는 월드 영역 (카메라 worldView 는 확대 방식 때문에 어긋나므로 대신 사용)
export function viewRect (scene: Phaser.Scene): Phaser.Geom.Rectangle
{
    const cam = scene.cameras.main;
    return new Phaser.Geom.Rectangle(cam.scrollX, cam.scrollY, GAME_WIDTH, GAME_HEIGHT);
}

//  모든 Text 를 TEXT_RESOLUTION 으로 그리도록 this.add.text() 를 바꿔 둔다 (게임 시작 전에 한 번 호출)
export function installCrispText ()
{
    const factory = Phaser.GameObjects.GameObjectFactory.prototype as unknown as {
        text: (x: number, y: number, text: string | string[], style?: Phaser.Types.GameObjects.Text.TextStyle) => Phaser.GameObjects.Text;
        displayList: Phaser.GameObjects.DisplayList;
        scene: Phaser.Scene;
    };
    factory.text = function (this: typeof factory, x, y, text, style)
    {
        const crisp = { resolution: TEXT_RESOLUTION, ...style };
        return this.displayList.add(new Phaser.GameObjects.Text(this.scene, x, y, text, crisp)) as Phaser.GameObjects.Text;
    };
}
