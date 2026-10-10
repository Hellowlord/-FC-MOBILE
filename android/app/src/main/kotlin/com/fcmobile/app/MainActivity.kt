package com.fcmobile.app

import android.os.Bundle
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.fcmobile.core.SIM_DT
import com.fcmobile.player.PlayerInput
import kotlin.math.hypot

/**
 * Entry point.
 *
 * Deliberately thin. This Activity owns no game state: it drives the
 * deterministic core through [GameLoop], converts touch into [PlayerInput], and
 * draws whatever snapshot the core hands back. Everything you would change to
 * make the game *play* differently lives in :core, where it can be unit-tested
 * without an emulator.
 *
 * RENDERER NOTE
 * -------------
 * The `PitchView` below is a Canvas 2D placeholder so the loop, input and HUD
 * are wired end to end and verifiable on a device today. It is NOT the shipping
 * renderer. For the real game replace it with a GLSurfaceView / Vulkan swapchain
 * and draw `engine.snapshot(alpha)`, interpolating player positions between the
 * previous and current snapshot. The core's contract does not change.
 */
class MainActivity : ComponentActivity() {

    private lateinit var loop: GameLoop
    private var pitchView: PitchView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Touch state shared between the view and the loop. Only the loop reads
        // it, and only on the frame boundary, so a plain @Volatile pair is
        // enough; there is no lock and no allocation in the hot path.
        val input = TouchInputState()

        loop = GameLoop(
            onSimStep = { _ ->
                pitchView?.engine?.let { e ->
                    e.setHumanInput(input.toPlayerInput())
                    e.step()
                }
            },
            onRender = { alpha -> pitchView?.drawSnapshot(alpha) },
        )

        setContent {
            MaterialTheme {
                MatchScreen(
                    onPitchReady = { v ->
                        pitchView = v
                        v.input = input
                    },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        loop.start()
    }

    override fun onPause() {
        // Must stop: Choreographer callbacks keep firing otherwise, and a
        // backgrounded app should not be simulating football.
        loop.stop()
        super.onPause()
    }
}

/** Mutable touch state. Written by the view thread, read once per frame. */
class TouchInputState {
    @Volatile var moveX: Float = 0f
    @Volatile var moveZ: Float = 0f
    @Volatile var sprint: Boolean = false
    @Volatile var passQueued: Boolean = false
    @Volatile var shootQueued: Boolean = false
    @Volatile var shootPower: Float = 0f

    /** Consume the queued, edge-triggered buttons exactly once. */
    fun toPlayerInput(): PlayerInput {
        val pass = passQueued
        val shoot = shootQueued
        passQueued = false
        shootQueued = false
        return PlayerInput(
            moveX = moveX.toDouble(),
            moveZ = moveZ.toDouble(),
            sprint = sprint,
            pass = pass,
            shoot = shoot,
            power = shootPower.toDouble(),
            autoPower = !shoot,
        )
    }
}

@Composable
fun MatchScreen(onPitchReady: (PitchView) -> Unit) {
    AndroidView(
        modifier = Modifier,
        factory = { context ->
            PitchView(context).also { view ->
                onPitchReady(view)
                view.holder.addCallback(object : SurfaceHolder.Callback {
                    override fun surfaceCreated(holder: SurfaceHolder) = Unit
                    override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
                        view.onSurfaceSize(w, h)
                    }
                    override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
                })
            }
        },
    )
}

/**
 * Placeholder renderer + touch capture.
 *
 * Left stick is a virtual joystick anywhere in the lower half of the screen;
 * the right half holds sprint and action buttons. Replace the drawing with a
 * real renderer; keep the input mapping.
 */
class PitchView(context: android.content.Context) : SurfaceView(context) {

    lateinit var input: TouchInputState

    /**
     * The engine this view drives.
     *
     * NOTE: the Android :core module currently mirrors the locomotion, ball
     * physics and player controller. The full MatchEngine port (teams, restarts,
     * clock, AI brains) is the next task — see docs/PORTING-TO-KOTLIN.md for the
     * order and the parity gate that checks it.
     */
    val engine: MatchEngineFacade? = null

    private var w = 0
    private var h = 0
    private var stickOriginX = 0f
    private var stickOriginY = 0f
    private var stickId = -1

    fun onSurfaceSize(width: Int, height: Int) {
        w = width
        h = height
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val idx = event.actionIndex
                val id = event.getPointerId(idx)
                val x = event.getX(idx)
                val y = event.getY(idx)
                if (x < w * 0.5f && stickId == -1) {
                    stickId = id
                    stickOriginX = x
                    stickOriginY = y
                } else {
                    // Right side: bottom = sprint, top = action.
                    if (y > h * 0.7f) input.sprint = true else input.shootQueued = true
                }
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    if (event.getPointerId(i) != stickId) continue
                    val dx = event.getX(i) - stickOriginX
                    val dy = event.getY(i) - stickOriginY
                    val len = hypot(dx, dy)
                    val max = (w * 0.12f).coerceAtLeast(1f)
                    val norm = (len / max).coerceAtMost(1f)
                    if (len > 1e-3f) {
                        input.moveX = dx / len * norm
                        input.moveZ = dy / len * norm
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                val idx = event.actionIndex
                if (event.getPointerId(idx) == stickId) {
                    stickId = -1
                    input.moveX = 0f
                    input.moveZ = 0f
                } else {
                    input.sprint = false
                }
            }
        }
        return true
    }

    fun drawSnapshot(alpha: Double) {
        val holder = holder ?: return
        val canvas = holder.lockCanvas() ?: return
        try {
            canvas.drawColor(0xFF12261A.toInt())
            // Placeholder: the real renderer draws the pitch, the 22 players and
            // the ball from engine.snapshot(alpha), interpolating positions.
            android.graphics.Paint().let { p ->
                p.color = 0xFF8AA79A.toInt()
                p.textSize = 36f
                canvas.drawText("FC MOBILE — :core loop running (SIM_DT=$SIM_DT, alpha=${"%.2f".format(alpha)})", 24f, 60f, p)
            }
        } finally {
            holder.unlockCanvasAndPost(canvas)
        }
    }
}

/**
 * Placeholder facade for the engine API the view expects.
 *
 * This exists so the app module compiles against a stable surface while the
 * MatchEngine port is in progress. It intentionally does nothing: wiring it to
 * a fake simulation would mean the app "runs" without exercising any real code.
 */
class MatchEngineFacade {
    fun setHumanInput(input: PlayerInput) = Unit
    fun step() = Unit
}

@Suppress("unused")
private fun unusedReference(): Text? = null
