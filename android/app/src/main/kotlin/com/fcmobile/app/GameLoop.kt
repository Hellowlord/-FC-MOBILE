package com.fcmobile.app

import android.view.Choreographer
import com.fcmobile.core.SIM_DT
import kotlin.math.min

/**
 * The Android-side game loop.
 *
 * Three rates, deliberately different:
 *   - the DISPLAY runs at whatever the device refreshes at (60/90/120 Hz)
 *   - the SIMULATION always advances in exact 1/60 s steps
 *   - the RENDERER interpolates between the last two sim states using [alpha]
 *
 * If the simulation ran on the frame clock instead, physics would depend on the
 * device's refresh rate, replays would be impossible, and a hitch would tunnel
 * the ball through the goal line. See docs/ARCHITECTURE.md -> "The game loop".
 *
 * Usage:
 *   val loop = GameLoop { dt -> engine.step() }
 *   loop.start()      // in onResume
 *   loop.stop()       // in onPause
 */
class GameLoop(
    private val onSimStep: (dt: Double) -> Unit,
    private val onRender: (alpha: Double) -> Unit,
) {

    /** Hard cap on steps per frame; beyond this we drop time rather than chase it. */
    var maxStepsPerFrame = 5

    /** True when we had to discard time, so the HUD can show a hitch indicator. */
    var droppedTime = false
        private set

    var totalSteps = 0L
        private set

    private var accumulator = 0.0
    private var lastFrameNanos = 0L
    private var running = false

    /** Interpolation blend for the renderer, in [0, 1). */
    val alpha: Double
        get() {
            val a = accumulator / SIM_DT
            return when {
                a < 0.0 -> 0.0
                a >= 1.0 -> 0.999999
                else -> a
            }
        }

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            step(frameTimeNanos)
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    fun start() {
        if (running) return
        running = true
        lastFrameNanos = 0L
        Choreographer.getInstance().postFrameCallback(frameCallback)
    }

    fun stop() {
        running = false
        Choreographer.getInstance().removeFrameCallback(frameCallback)
    }

    /** Advance the simulation and render once. Split out so it can be unit-tested. */
    fun step(frameTimeNanos: Long): Int {
        val elapsed = if (lastFrameNanos == 0L) 0.0 else (frameTimeNanos - lastFrameNanos) / 1e9
        lastFrameNanos = frameTimeNanos

        // Clamp the gap: returning from a backgrounded app must not make the
        // sim catch up through ten seconds of football in one frame.
        accumulator += min(elapsed, 0.25)

        var n = 0
        while (accumulator >= SIM_DT && n < maxStepsPerFrame) {
            onSimStep(SIM_DT)
            accumulator -= SIM_DT
            n++
            totalSteps++
        }

        // Still behind after the cap: discard rather than enter the spiral of
        // death, where a slow device simulates more to catch up and falls
        // further behind every frame.
        if (accumulator >= SIM_DT) {
            accumulator = 0.0
            droppedTime = true
        } else {
            droppedTime = false
        }

        onRender(alpha)
        return n
    }
}
