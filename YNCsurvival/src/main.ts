import StartGame from './game/main';

document.addEventListener('DOMContentLoaded', () => {

    const game = StartGame('game-container');

    //  개발 모드(npm run dev)에서만 브라우저 콘솔에서 window.game 으로 게임 상태 확인 가능
    //  예: game.scene.getScene('Game').stats
    if (import.meta.env.DEV)
    {
        (window as unknown as { game: Phaser.Game }).game = game;
    }

});
