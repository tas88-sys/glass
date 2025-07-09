#!/usr/bin/env node

/**
 * Test script to validate window resize and movement fixes
 * Run this with: node test_fixes.js
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testing Window Resize and Movement Fixes');
console.log('==========================================');

// Test 1: Build the application
console.log('\n1. Building application...');
const buildProcess = spawn('npm', ['run', 'build:renderer'], {
    cwd: process.cwd(),
    stdio: 'inherit'
});

buildProcess.on('close', (code) => {
    if (code === 0) {
        console.log('✅ Build successful');
        
        // Test 2: Start the application
        console.log('\n2. Starting application...');
        const appProcess = spawn('npm', ['start'], {
            cwd: process.cwd(),
            stdio: 'inherit'
        });

        console.log('\n📋 Manual Testing Instructions:');
        console.log('===============================');
        console.log('Once the app starts, please test the following:');
        console.log('');
        console.log('🔧 Resize Test:');
        console.log('  - Switch between API key input and main header');
        console.log('  - Verify window resizes smoothly and stays centered');
        console.log('  - Long-press on window and verify no width increase');
        console.log('');
        console.log('🎯 Movement Test:');
        console.log('  - Use Cmd/Ctrl + arrow keys to move window');
        console.log('  - Move down multiple times and verify no restriction');
        console.log('  - Test movement in all directions');
        console.log('  - Drag window around and verify smooth movement');
        console.log('');
        console.log('🖥️ Pixelation Test:');
        console.log('  - Check that all UI elements are crisp and clear');
        console.log('  - Move window between displays if available');
        console.log('  - Verify text and icons remain sharp');
        console.log('');
        console.log('📊 Debug Logs:');
        console.log('  - Check console for debug messages starting with:');
        console.log('    [WindowManager] and [MovementManager]');
        console.log('  - Verify no error messages appear');
        console.log('');
        console.log('Press Ctrl+C to stop the application');

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n🛑 Stopping application...');
            appProcess.kill('SIGINT');
            process.exit(0);
        });

    } else {
        console.log('❌ Build failed');
        process.exit(1);
    }
});

buildProcess.on('error', (err) => {
    console.error('❌ Build error:', err);
    process.exit(1);
});