// ==UserScript==
// @name         YouTube Timestamp Saver
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  Remembers and restores your last watched position in YouTube videos with a beautiful UI
// @author       Your Name
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://m.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    // Default settings
    const defaultSettings = {
        themeMode: 'dark', // dark, light, system
        autoSave: true,
        saveInterval: 5, // seconds
        notificationDuration: 3000, // milliseconds
        removeTimestampFromURL: false,
        smartTimestampHandling: true,
        notifyOnAutoSave: false,
        minSaveInterval: 30, // minimum seconds between saves
        customAccentColor: '#2196F3',
        blurAmount: 24, // blur amount in pixels (0 = disabled)
        timestampFormat: 'hh:mm:ss',
        autoResume: true,
        notificationPosition: {
            duringPlayback: {
                position: 'top-right',
                margin: 120 // pixels
            },
            onHomepage: {
                position: 'bottom-right',
                margin: 120 // pixels
            }
        },
        maxStoredTimestamps: 100,
        syncBehavior: 'latest',
        debugMode: false,
        settingsHotkey: 'CTRL+SHIFT+S', // Default hotkey for opening settings
        preset: 'custom', // custom, chrome, firefox
        saveOnPause: true, // Save position when video is paused
        notificationSize: 'medium', // small, medium, large
        enableNotifications: true, // Master switch for all notifications
        restoreNotifications: true, // Show notifications when position is restored
    };

    // Get settings with validation
    let settings = (() => {
        const savedSettings = GM_getValue('ytTimestampSettings', {});
        
        // Deep merge with defaults to ensure all properties exist
        const mergedSettings = {
            ...defaultSettings,
            ...savedSettings
        };

        // Ensure notification position structure is complete
        mergedSettings.notificationPosition = {
            duringPlayback: {
                position: savedSettings?.notificationPosition?.duringPlayback?.position || defaultSettings.notificationPosition.duringPlayback.position,
                margin: savedSettings?.notificationPosition?.duringPlayback?.margin ?? defaultSettings.notificationPosition.duringPlayback.margin
            },
            onHomepage: {
                position: savedSettings?.notificationPosition?.onHomepage?.position || defaultSettings.notificationPosition.onHomepage.position,
                margin: savedSettings?.notificationPosition?.onHomepage?.margin ?? defaultSettings.notificationPosition.onHomepage.margin
            }
        };

        // Handle migration from old state names if needed
        if (savedSettings?.notificationPosition?.playingVideos) {
            mergedSettings.notificationPosition.duringPlayback = {
                position: savedSettings.notificationPosition.playingVideos.position,
                margin: savedSettings.notificationPosition.playingVideos.margin
            };
        }
        if (savedSettings?.notificationPosition?.mainMenu) {
            mergedSettings.notificationPosition.onHomepage = {
                position: savedSettings.notificationPosition.mainMenu.position,
                margin: savedSettings.notificationPosition.mainMenu.margin
            };
        }
        
        // Save merged settings back to storage
        GM_setValue('ytTimestampSettings', mergedSettings);
        
        return mergedSettings;
    })();

    // Optimized debug logger with rate limiting for high-frequency messages
    const debug = (message, data) => {
        if (!settings?.debugMode) return;
        
        // Use static properties for tracking message frequency
        debug.messageCounter = debug.messageCounter || new Map();
        debug.lastLogTime = debug.lastLogTime || new Map();
        debug.messageGroups = debug.messageGroups || {
            // Group similar messages for tracking
            highFrequency: [
                'Skipping', 'checking', 'Auto-save', 'Video state',
                'No video', 'Loading', 'Trying', 'Processing'
            ],
            // Messages that should always be shown
            important: [
                'Timestamp saved', 'Manual save', 'Restoring', 'Welcome back',
                'initialization', 'New video', 'Error', 'Failed'
            ]
        };
        
        // Get message category based on content
        const getMessageCategory = (msg) => {
            const firstWord = msg.split(' ')[0];
            
            // Check if it's a high frequency message
            const isHighFreq = debug.messageGroups.highFrequency.some(
                term => msg.includes(term)
            );
            
            // Check if it's an important message that should always show
            const isImportant = debug.messageGroups.important.some(
                term => msg.includes(term)
            );
            
            // Return the appropriate category key
            if (isImportant) return 'important';
            if (isHighFreq) return firstWord || 'highFreq';
            return firstWord || 'other';
        };
        
        // Determine if message should be throttled
        const now = Date.now();
        const category = getMessageCategory(message);
        const isHighFrequency = category !== 'important' && category !== 'other';
        
        if (isHighFrequency) {
            const lastTime = debug.lastLogTime.get(category) || 0;
            const counter = debug.messageCounter.get(category) || 0;
            
            // High frequency messages: throttle to max once per 3 seconds
            if (now - lastTime < 3000) {
                debug.messageCounter.set(category, counter + 1);
                return; // Skip logging this message
            } else {
                // Log with count if we suppressed messages
                const suppressedCount = debug.messageCounter.get(category) || 0;
                if (suppressedCount > 0) {
                    console.log(`[YT Timestamp] ${message} (+ ${suppressedCount} similar messages suppressed)`);
                    debug.messageCounter.set(category, 0);
                } else {
                    console.log(`[YT Timestamp] ${message}`, data || '');
                }
                debug.lastLogTime.set(category, now);
            }
        } else {
            // Normal logging for regular or important messages
            console.log(`[YT Timestamp] ${message}`, data || '');
        }
    };

    // Global state variables
    let currentVideoId = '';
    let lastSaveTime = 0;
    let isNotificationShowing = false;
    const notificationQueue = [];
    let settingsHotkey = 'CTRL+SHIFT+S'; // Default hotkey for opening settings
    let notificationContainer = null; // Cache for notification container
    let notificationTimeout = null; // Store timeout reference
    let notificationAnimationFrame = null; // Store animation frame reference
    let cachedPlayer = null; // Cache player reference
    let lastPlayerRect = null; // Cache player dimensions
    let resizeDebounceTimeout = null; // For debouncing resize events

    // Update styles
    const styles = `
        :root {
            --base-size: min(1.6vh, 16px);
            --notification-width: clamp(280px, 30vw, 400px);
            --settings-width: clamp(380px, 45vw, 700px);
            --primary-color: #2196F3;
            --success-color: #4CAF50;
            --warning-color: #FFC107;
            --error-color: #F44336;
            --text-primary: rgba(255, 255, 255, 0.95);
            --text-secondary: rgba(255, 255, 255, 0.7);
            --bg-primary: rgba(25, 25, 25, var(--bg-opacity, 0.85));
            --bg-secondary: rgba(35, 35, 35, var(--bg-opacity, 0.85));
            --bg-hover: rgba(255, 255, 255, 0.1);
            --bg-active: rgba(255, 255, 255, 0.15);
            --border-color: rgba(255, 255, 255, 0.15);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.15);
            --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.2);
            --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.3);
            --transition-smooth: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            --border-radius-sm: 6px;
            --border-radius-md: 12px;
            --border-radius-lg: 16px;
            --spacing-xs: 4px;
            --spacing-sm: 8px;
            --spacing-md: 16px;
            --spacing-lg: 24px;
            --spacing-xl: 32px;
            --font-size: 14px;
            --blur-effect: blur(24px) saturate(180%);
            --bg-opacity: 0.85;
        }

        /* Light mode theme variables */
        .light-theme {
            --text-primary: rgba(0, 0, 0, 0.87);
            --text-secondary: rgba(0, 0, 0, 0.6);
            --bg-primary: rgba(255, 255, 255, 0.98);
            --bg-secondary: rgba(245, 245, 245, 0.98);
            --bg-hover: rgba(0, 0, 0, 0.04);
            --bg-active: rgba(0, 0, 0, 0.08);
            --border-color: rgba(0, 0, 0, 0.12);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.08);
            --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.12);
            --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.16);
        }

        /* Dynamic styles that will be updated via script */
        .yt-timestamp-theme-vars {
            --primary-color: #2196F3;
            --bg-primary: rgba(25, 25, 25, 0.85);
            --bg-secondary: rgba(35, 35, 35, 0.85);
            --text-primary: rgba(255, 255, 255, 0.95);
            --text-secondary: rgba(255, 255, 255, 0.7);
            --border-color: rgba(255, 255, 255, 0.15);
            --bg-hover: rgba(255, 255, 255, 0.1);
            --bg-active: rgba(255, 255, 255, 0.15);
            --font-size: 14px;
            --blur-effect: blur(24px) saturate(180%);
        }

        /* Notification Styles */
        .yt-timestamp-notification {
            position: fixed;
            background: var(--bg-primary);
            backdrop-filter: var(--blur-effect);
            -webkit-backdrop-filter: var(--blur-effect);
            border-radius: var(--border-radius-lg);
            padding: var(--spacing-md);
            color: var(--text-primary);
            font-family: 'YouTube Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: var(--font-size);
            z-index: 9999;
            box-shadow: var(--shadow-lg);
            display: flex;
            flex-direction: column;
            gap: var(--spacing-sm);
            transition: var(--transition-smooth);
            opacity: 0;
            pointer-events: none;
            width: var(--notification-width);
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.07);
            transform: translateY(-20px) scale(0.95);
        }

        .yt-timestamp-notification.show {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(0) scale(1);
        }

        .yt-timestamp-notification.light {
            background: rgba(255, 255, 255, var(--bg-opacity, 0.95));
            color: rgba(0, 0, 0, 0.9);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .notification-content {
            display: flex;
            align-items: center;
            gap: var(--spacing-md);
            padding: var(--spacing-xs) var(--spacing-sm);
        }

        .notification-emoji {
            font-size: 20px;
            min-width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-hover);
            border-radius: 50%;
            padding: var(--spacing-xs);
        }

        .notification-message {
            flex: 1;
            font-weight: 500;
        }

        .notification-progress {
            height: 3px;
            width: 100%;
            background: var(--primary-color);
            opacity: 0.7;
            border-radius: var(--border-radius-sm);
            align-self: flex-start;
            transform-origin: left;
            margin-top: var(--spacing-xs);
        }

        /* Settings UI */
        .yt-timestamp-settings {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) scale(0.9);
            width: var(--settings-width);
            max-width: 95vw;
            max-height: 90vh;
            background: var(--bg-primary);
            backdrop-filter: var(--blur-effect);
            -webkit-backdrop-filter: var(--blur-effect);
            border-radius: var(--border-radius-lg);
            color: var(--text-primary);
            font-family: 'YouTube Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            z-index: 10000;
            box-shadow: var(--shadow-lg);
            border: 1px solid rgba(255, 255, 255, 0.07);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            opacity: 0;
            pointer-events: none;
            transition: var(--transition-smooth);
        }

        .yt-timestamp-settings.show {
            opacity: 1;
            pointer-events: auto;
            transform: translate(-50%, -50%) scale(1);
        }

        .yt-timestamp-settings.light {
            background: rgba(255, 255, 255, 0.98);
            color: rgba(0, 0, 0, 0.9);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .setting-option {
            background: rgba(245, 245, 245, 0.95);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .setting-description {
            color: rgba(0, 0, 0, 0.7);
        }

        .yt-timestamp-settings.light .settings-tab {
            color: rgba(0, 0, 0, 0.7);
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .settings-tab:hover {
            background: rgba(0, 0, 0, 0.08);
            color: rgba(0, 0, 0, 0.87);
        }

        .yt-timestamp-settings.light .settings-tab.active {
            background: rgba(0, 0, 0, 0.08);
            color: var(--primary-color);
        }

        .settings-header {
            display: flex;
            flex-direction: column;
            padding: var(--spacing-md);
            border-bottom: 1px solid var(--border-color);
        }

        .settings-title {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: var(--spacing-md);
        }

        .settings-title h2 {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
        }

        .settings-close {
            font-size: 28px;
            cursor: pointer;
            line-height: 1;
            opacity: 0.8;
            transition: var(--transition-smooth);
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
        }

        .settings-close:hover {
            opacity: 1;
            background: var(--bg-hover);
        }

        .settings-tabs {
            display: flex;
            gap: var(--spacing-sm);
            overflow-x: auto;
            padding-bottom: var(--spacing-sm);
            scrollbar-width: thin;
        }

        .settings-tabs::-webkit-scrollbar {
            height: 4px;
        }

        .settings-tabs::-webkit-scrollbar-track {
            background: transparent;
        }

        .settings-tabs::-webkit-scrollbar-thumb {
            background: var(--border-color);
            border-radius: var(--border-radius-sm);
        }

        .settings-tab {
            background: transparent;
            border: none;
            color: var(--text-secondary);
            font-family: inherit;
            font-size: 14px;
            padding: var(--spacing-sm) var(--spacing-md);
            border-radius: var(--border-radius-md);
            cursor: pointer;
            transition: var(--transition-smooth);
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            white-space: nowrap;
        }

        .yt-timestamp-settings.light .settings-tab {
            color: rgba(0, 0, 0, 0.7);
        }

        .settings-tab:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }

        .settings-tab.active {
            background: var(--bg-hover);
            color: var(--primary-color);
            font-weight: 500;
        }

        .tab-icon {
            font-size: 16px;
        }

        .settings-content {
            padding: var(--spacing-md);
            overflow-y: auto;
            max-height: calc(90vh - 120px);
        }

        .settings-page {
            display: none;
        }

        .settings-section {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
        }

        .setting-option {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs);
            padding: var(--spacing-md);
            background: var(--bg-secondary);
            border-radius: var(--border-radius-md);
            transition: var(--transition-smooth);
        }

        .setting-option:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-sm);
        }

        .setting-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: var(--spacing-sm);
        }

        .setting-label {
            font-weight: 500;
            font-size: 15px;
            margin: 0;
        }

        .setting-description {
            color: var(--text-secondary);
            font-size: 13px;
            margin: 0;
            margin-top: 2px;
        }

        .setting-control {
            margin-left: auto;
            display: flex;
            align-items: center;
        }

        /* Format Selector */
        .format-option {
            padding: var(--spacing-sm);
            border-radius: var(--border-radius-sm);
            background: var(--bg-hover);
            cursor: pointer;
            text-align: center;
            transition: var(--transition-smooth);
            border: 2px solid transparent;
        }

        .format-option:hover {
            background: var(--bg-active);
            transform: translateY(-2px);
        }

        .format-option.active {
            border-color: var(--primary-color);
            background: var(--bg-active);
        }

        .yt-timestamp-settings.light .format-option {
            background: rgba(0, 0, 0, 0.05);
        }

        .yt-timestamp-settings.light .format-option:hover,
        .yt-timestamp-settings.light .format-option.active {
            background: rgba(0, 0, 0, 0.08);
        }

        /* Modern Controls */
        .modern-input[type="checkbox"] {
            position: absolute;
            opacity: 0;
            width: 0;
            height: 0;
        }

        .modern-slider {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
            background-color: rgba(255, 255, 255, 0.1);
            border-radius: 24px;
            transition: var(--transition-smooth);
            cursor: pointer;
        }

        .yt-timestamp-settings.light .modern-slider {
            background-color: rgba(0, 0, 0, 0.1);
        }

        .modern-slider:before {
            position: absolute;
            content: "";
            height: 20px;
            width: 20px;
            left: 2px;
            bottom: 2px;
            background-color: #fff;
            box-shadow: var(--shadow-sm);
            border-radius: 50%;
            transition: var(--transition-smooth);
        }

        .yt-timestamp-settings.light .modern-slider:before {
            background-color: #fff;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        input:checked + .modern-slider {
            background-color: var(--primary-color);
        }

        input:checked + .modern-slider:before {
            transform: translateX(24px);
        }

        .modern-input[type="text"],
        .modern-input[type="number"],
        .modern-input[type="range"],
        .modern-select {
            background: var(--bg-hover);
            border: 1px solid var(--border-color);
            border-radius: var(--border-radius-sm);
            color: var(--text-primary);
            padding: var(--spacing-sm) var(--spacing-md);
            font-family: inherit;
            font-size: 14px;
            transition: var(--transition-smooth);
        }

        .yt-timestamp-settings.light .modern-input[type="text"],
        .yt-timestamp-settings.light .modern-input[type="number"],
        .yt-timestamp-settings.light .modern-input[type="range"],
        .yt-timestamp-settings.light .modern-select {
            background: rgba(0, 0, 0, 0.05);
            color: #0f0f0f;
        }

        .modern-input[type="text"]:focus,
        .modern-input[type="number"]:focus,
        .modern-select:focus {
            outline: none;
            border-color: var(--primary-color);
            box-shadow: 0 0 0 1px var(--primary-color);
        }

        .modern-input[type="range"] {
            -webkit-appearance: none;
            width: 100%;
            height: 6px;
            background: var(--bg-hover);
            border-radius: var(--border-radius-sm);
            outline: none;
            padding: 0;
        }

        .yt-timestamp-settings.light .modern-input[type="range"] {
            background: rgba(0, 0, 0, 0.1);
        }

        .modern-input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            background: var(--primary-color);
            border-radius: 50%;
            cursor: pointer;
            transition: var(--transition-smooth);
        }

        .modern-input[type="range"]::-moz-range-thumb {
            width: 16px;
            height: 16px;
            background: var(--primary-color);
            border-radius: 50%;
            cursor: pointer;
            border: none;
            transition: var(--transition-smooth);
        }

        .modern-input[type="range"]::-webkit-slider-thumb:hover {
            transform: scale(1.2);
        }

        .modern-input[type="range"]::-moz-range-thumb:hover {
            transform: scale(1.2);
        }

        .color-picker {
            display: flex;
            gap: var(--spacing-sm);
            flex-wrap: wrap;
            padding: var(--spacing-xs);
        }

        .color-option {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            cursor: pointer;
            transition: var(--transition-smooth);
            border: 2px solid transparent;
        }

        .color-option.active {
            border-color: var(--text-primary);
            transform: scale(1.1);
        }

        .color-option:hover {
            transform: scale(1.15);
        }

        /* Position Picker */
        .position-picker {
            display: flex;
            flex-direction: column;
            background: var(--bg-hover);
            border-radius: var(--border-radius-md);
            padding: var(--spacing-md);
            border: 1px solid var(--border-color);
            position: relative;
            width: 240px;
            height: auto;
            margin-top: 32px;
            box-shadow: var(--shadow-sm);
        }

        .yt-timestamp-settings.light .position-picker {
            background: rgba(0, 0, 0, 0.05);
        }

        .screen-representation {
            position: absolute;
            top: -28px;
            left: 0;
            right: 0;
            height: 24px;
            background: var(--primary-color);
            border-radius: var(--border-radius-sm) var(--border-radius-sm) 0 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
            font-weight: 500;
            opacity: 0.9;
        }

        .position-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            grid-template-rows: repeat(3, 1fr);
            gap: 12px;
            width: 100%;
            height: 140px;
            position: relative;
        }

        .position-grid::after {
            content: '';
            position: absolute;
            inset: 0;
            border: 1px dashed var(--border-color);
            pointer-events: none;
            z-index: 0;
        }

        .position-option {
            width: 100%;
            height: 100%;
            min-height: 32px;
            border-radius: var(--border-radius-sm);
            background: var(--bg-active);
            cursor: pointer;
            transition: var(--transition-smooth);
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            z-index: 1;
            opacity: 0.7;
        }

        .yt-timestamp-settings.light .position-option {
            background: rgba(0, 0, 0, 0.08);
        }

        .position-dot {
            width: 8px;
            height: 8px;
            background: var(--text-secondary);
            border-radius: 50%;
            transition: var(--transition-smooth);
        }

        .position-option:hover {
            transform: scale(1.05);
            box-shadow: var(--shadow-sm);
            opacity: 0.9;
        }

        .position-option.active {
            background: var(--primary-color);
            box-shadow: var(--shadow-sm);
            opacity: 1;
            z-index: 2;
        }

        .position-option.active .position-dot {
            background: white;
            transform: scale(1.2);
        }

        .position-preview {
            position: absolute;
            background: var(--primary-color);
            color: white;
            font-size: 10px;
            padding: 2px 4px;
            border-radius: 3px;
            opacity: 0;
            transition: opacity 0.2s ease;
            pointer-events: none;
            white-space: nowrap;
        }

        .position-option:hover .position-preview {
            opacity: 0.9;
        }

        /* Position the previews around the grid according to their position */
        .position-option[data-position="top-left"] .position-preview {
            bottom: 100%;
            left: 0;
            margin-bottom: 4px;
        }

        .position-option[data-position="top-center"] .position-preview {
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-bottom: 4px;
        }

        .position-option[data-position="top-right"] .position-preview {
            bottom: 100%;
            right: 0;
            margin-bottom: 4px;
        }

        .position-option[data-position="center-left"] .position-preview {
            top: 50%;
            right: 100%;
            transform: translateY(-50%);
            margin-right: 4px;
        }

        .position-option[data-position="center-center"] .position-preview {
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }

        .position-option[data-position="center-right"] .position-preview {
            top: 50%;
            left: 100%;
            transform: translateY(-50%);
            margin-left: 4px;
        }

        .position-option[data-position="bottom-left"] .position-preview {
            top: 100%;
            left: 0;
            margin-top: 4px;
        }

        .position-option[data-position="bottom-center"] .position-preview {
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-top: 4px;
        }

        .position-option[data-position="bottom-right"] .position-preview {
            top: 100%;
            right: 0;
            margin-top: 4px;
        }

        /* Timestamp Control buttons */
            .timestamp-button {
            background: var(--bg-primary);
            color: var(--text-primary);
            border: none;
            border-radius: var(--border-radius-md);
            font-size: 14px;
            font-family: inherit;
            padding: 8px 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            cursor: pointer;
            box-shadow: var(--shadow-md);
            backdrop-filter: var(--blur-effect);
            -webkit-backdrop-filter: var(--blur-effect);
            transition: var(--transition-smooth);
        }

        .timestamp-button:hover {
            background: var(--bg-hover);
            transform: translateY(-2px);
        }

        .timestamp-button .emoji {
            font-size: 16px;
        }

        /* Browser Preset Selector */
        .browser-presets {
            display: flex;
            gap: var(--spacing-md);
            justify-content: space-between;
            width: 100%;
        }

        .browser-preset {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--spacing-sm);
            padding: var(--spacing-md);
            border-radius: var(--border-radius-md);
            background-color: var(--bg-hover);
            cursor: pointer;
            transition: var(--transition-smooth);
            flex: 1;
            border: 2px solid transparent;
        }

        .browser-preset:hover {
            transform: translateY(-4px);
            background-color: var(--bg-active);
        }

        .browser-preset.active {
            border-color: var(--primary-color);
            background-color: var(--bg-active);
        }

        .browser-icon {
            font-size: 32px;
            margin-bottom: var(--spacing-xs);
        }

        .browser-name {
            font-weight: 500;
            font-size: 14px;
        }

        .browser-desc {
            color: var(--text-secondary);
            font-size: 12px;
            text-align: center;
        }

        /* Size Selector styles (replacing dropdown) */
        .size-selector {
            display: flex;
            gap: var(--spacing-md);
            width: 100%;
        }

        .size-option {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--spacing-xs);
            padding: var(--spacing-md);
            background: var(--bg-hover);
            border-radius: var(--border-radius-md);
            cursor: pointer;
            transition: var(--transition-smooth);
            border: 2px solid transparent;
            text-align: center;
        }

        .size-option:hover {
            background: var(--bg-active);
            transform: translateY(-2px);
        }

        .size-option.active {
            border-color: var(--primary-color);
            background: var(--bg-active);
        }

        .size-preview {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--spacing-xs);
            padding: var(--spacing-xs) var(--spacing-sm);
            background: var(--bg-primary);
            border-radius: var(--border-radius-sm);
            width: 100%;
            margin-bottom: var(--spacing-xs);
            border: 1px solid var(--border-color);
        }

        .size-preview-icon {
            font-size: 14px;
        }

        .size-preview-text {
            font-size: 10px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .size-option.small .size-preview {
            height: 26px;
            max-width: 80%;
        }

        .size-option.small .size-preview-icon {
            font-size: 12px;
        }

        .size-option.small .size-preview-text {
            font-size: 9px;
        }

        .size-option.medium .size-preview {
            height: 32px;
        }

        .size-option.large .size-preview {
            height: 40px;
            max-width: 100%;
        }

        .size-option.large .size-preview-icon {
            font-size: 16px;
        }

        .size-option.large .size-preview-text {
            font-size: 12px;
        }

        .size-label {
            font-weight: 500;
            font-size: 13px;
        }

        .size-description {
            color: var(--text-secondary);
            font-size: 11px;
        }

        .yt-timestamp-settings.light .size-option {
            background: rgba(0, 0, 0, 0.05);
        }

        .yt-timestamp-settings.light .size-option:hover,
        .yt-timestamp-settings.light .size-option.active {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .size-preview {
            background: rgba(255, 255, 255, 0.9);
            border: 1px solid rgba(0, 0, 0, 0.15);
            color: rgba(0, 0, 0, 0.9);
        }

        /* Theme Selector */
        .theme-selector {
            display: flex;
            gap: var(--spacing-md);
            width: 100%;
        }

        .theme-option {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--spacing-xs);
            padding: var(--spacing-md);
            background: var(--bg-hover);
            border-radius: var(--border-radius-md);
            cursor: pointer;
            transition: var(--transition-smooth);
            border: 2px solid transparent;
            text-align: center;
        }

        .theme-option:hover {
            background: var(--bg-active);
            transform: translateY(-2px);
        }

        .theme-option.active {
            border-color: var(--primary-color);
            background: var(--bg-active);
        }

        .theme-preview {
            width: 100%;
            height: 50px;
            border-radius: var(--border-radius-sm);
            margin-bottom: var(--spacing-xs);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
        }

        .theme-preview.dark {
            background: #1f1f1f;
            color: white;
        }

        .theme-preview.light {
            background: #f5f5f5;
            color: #1f1f1f;
        }

        .theme-preview.system {
            background: linear-gradient(to right, #1f1f1f 0%, #1f1f1f 50%, #f5f5f5 50%, #f5f5f5 100%);
        }

        .theme-preview.system::before {
            content: "Auto";
            position: absolute;
            color: white;
            left: 25%;
            transform: translateX(-50%);
        }

        .theme-preview.system::after {
            content: "Auto";
            position: absolute;
            color: #1f1f1f;
            right: 25%;
            transform: translateX(50%);
        }

        .theme-preview-icon {
            font-size: 18px;
        }

        .theme-label {
            font-weight: 500;
            font-size: 13px;
        }

        .theme-description {
            color: var(--text-secondary);
            font-size: 11px;
        }

        .yt-timestamp-settings.light .theme-option {
            background: rgba(0, 0, 0, 0.05);
        }

        .yt-timestamp-settings.light .theme-option:hover,
        .yt-timestamp-settings.light .theme-option.active {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .theme-description {
            color: rgba(0, 0, 0, 0.6);
        }

        .yt-timestamp-settings.light .theme-label {
            color: rgba(0, 0, 0, 0.9);
            font-weight: 500;
        }

        .yt-timestamp-settings.light .browser-name {
            color: rgba(0, 0, 0, 0.9);
        }

        .yt-timestamp-settings.light .browser-description {
            color: rgba(0, 0, 0, 0.65);
        }

        .yt-timestamp-settings .sync-option-cards {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin: 15px 0 5px 0;
            width: 100%;
        }
        
        .yt-timestamp-settings .sync-header {
            font-size: 13px;
            color: var(--text-secondary, rgba(0,0,0,0.6));
            margin-bottom: 8px;
            padding-left: 2px;
        }
        
        .yt-timestamp-settings .sync-cards-wrapper {
            display: flex;
            gap: 10px;
            width: 100%;
        }
        
        .yt-timestamp-settings .sync-card {
            flex: 1;
            border-radius: 6px;
            padding: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: flex-start;
            text-align: left;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            border: 1px solid var(--border-color, rgba(0,0,0,0.1));
        }
        
        .yt-timestamp-settings .sync-card.active {
            background: var(--custom-accent, #3ea6ff);
            color: white;
            border-color: var(--custom-accent, #3ea6ff);
        }
        
        .yt-timestamp-settings .sync-card:not(.active) {
            background: var(--bg-secondary, rgba(0,0,0,0.02));
        }
        
        .yt-timestamp-settings .sync-card:hover:not(.active) {
            transform: translateY(-2px);
            box-shadow: 0 3px 8px rgba(0,0,0,0.12);
            border-color: var(--border-hover, rgba(0,0,0,0.2));
        }
        
        .yt-timestamp-settings .sync-icon-wrapper {
            margin-right: 10px;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255,255,255,0.85);
            border-radius: 50%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }
        
        .yt-timestamp-settings .sync-card.active .sync-icon-wrapper {
            background: rgba(255,255,255,0.25);
            box-shadow: 0 1px 2px rgba(0,0,0,0.2);
        }
        
        .yt-timestamp-settings .sync-content {
            flex: 1;
        }
        
        .yt-timestamp-settings .sync-icon {
            font-size: 20px;
        }
        
        .yt-timestamp-settings .sync-label {
            font-weight: 600;
            margin-bottom: 4px;
            font-size: 14px;
        }
        
        .yt-timestamp-settings .sync-description {
            font-size: 12px;
            opacity: 0.85;
            line-height: 1.3;
        }

        .yt-timestamp-settings .settings-tab .tab-icon {
            margin-right: 2px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            vertical-align: middle;
        }

        /* Position Selector styles - make it match size-selector */
        .position-selector {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: var(--spacing-md);
            width: 100%;
        }

        /* Override old styles with the new ones */
        .position-option {
            width: auto !important;
            height: auto !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            gap: var(--spacing-xs) !important;
            padding: var(--spacing-md) !important;
            background: var(--bg-hover) !important;
            border-radius: var(--border-radius-md) !important;
            cursor: pointer !important;
            transition: var(--transition-smooth) !important;
            border: 2px solid transparent !important;
            text-align: center !important;
            opacity: 1 !important;
            position: static !important; /* Reset position */
            z-index: 1 !important;
        }

        .position-option:hover {
            background: var(--bg-active) !important;
            transform: translateY(-2px) !important;
            box-shadow: var(--shadow-sm) !important;
            opacity: 1 !important;
        }

        .position-option.active {
            border-color: var(--primary-color) !important;
            background: var(--bg-active) !important;
            box-shadow: var(--shadow-sm) !important;
            opacity: 1 !important;
        }

        /* Completely new class names to avoid conflicts */
        .position-preview-container {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            margin-bottom: var(--spacing-xs);
        }

        .player-representation {
            width: 90%;
            height: 50px;
            background: rgba(0, 0, 0, 0.7);
            border-radius: var(--border-radius-sm);
            position: relative;
            border: 1px solid var(--border-color);
        }

        .notification-dot {
            position: absolute;
            width: 10px;
            height: 10px;
            background: var(--primary-color);
            border-radius: 50%;
            z-index: 1;
        }

        /* Position the notification dot based on its position value */
        .notification-dot.top-left {
            top: 5px;
            left: 5px;
        }

        .notification-dot.top-center {
            top: 5px;
            left: 50%;
            transform: translateX(-50%);
        }

        .notification-dot.top-right {
            top: 5px;
            right: 5px;
        }

        .notification-dot.center-left {
            top: 50%;
            left: 5px;
            transform: translateY(-50%);
        }

        .notification-dot.center-center {
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }

        .notification-dot.center-right {
            top: 50%;
            right: 5px;
            transform: translateY(-50%);
        }

        .notification-dot.bottom-left {
            bottom: 5px;
            left: 5px;
        }

        .notification-dot.bottom-center {
            bottom: 5px;
            left: 50%;
            transform: translateX(-50%);
        }

        .notification-dot.bottom-right {
            bottom: 5px;
            right: 5px;
        }

        .position-label {
            font-weight: 500;
            font-size: 13px;
        }

        .position-description {
            color: var(--text-secondary);
            font-size: 11px;
        }

        .yt-timestamp-settings.light .position-option {
            background: rgba(0, 0, 0, 0.05) !important;
        }

        .yt-timestamp-settings.light .position-option:hover,
        .yt-timestamp-settings.light .position-option.active {
            background: rgba(0, 0, 0, 0.08) !important;
        }

        .yt-timestamp-settings.light .player-representation {
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(0, 0, 0, 0.15);
        }

        /* Remove old position picker styles that are no longer needed */
        .position-picker,
        .position-grid,
        .screen-representation,
        .position-dot {
            /* These styles are now replaced with the new implementation */
        }

        /* Position preview needs to be preserved for other elements but modified for our component */
        .position-option .position-preview {
            display: none !important; /* Hide the old preview */
        }

        /* Add CSS for the missing center positions */
        .notification-dot.center-left {
            top: 50%;
            left: 5px;
            transform: translateY(-50%);
        }

        .notification-dot.center-center {
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }

        .notification-dot.center-right {
            top: 50%;
            right: 5px;
            transform: translateY(-50%);
        }

        /* Light mode overrides for settings components */
        .yt-timestamp-settings.light .setting-option {
            background: rgba(245, 245, 245, 0.95);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .format-option,
        .yt-timestamp-settings.light .theme-option,
        .yt-timestamp-settings.light .position-option,
        .yt-timestamp-settings.light .browser-preset,
        .yt-timestamp-settings.light .sync-option {
            background: rgba(0, 0, 0, 0.04);
            border: 1px solid rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .format-option:hover,
        .yt-timestamp-settings.light .theme-option:hover,
        .yt-timestamp-settings.light .position-option:hover,
        .yt-timestamp-settings.light .browser-preset:hover,
        .yt-timestamp-settings.light .sync-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .format-option.active,
        .yt-timestamp-settings.light .theme-option.active,
        .yt-timestamp-settings.light .position-option.active,
        .yt-timestamp-settings.light .browser-preset.active,
        .yt-timestamp-settings.light .sync-option.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        .yt-timestamp-settings.light .format-preview,
        .yt-timestamp-settings.light .theme-preview,
        .yt-timestamp-settings.light .position-preview-container,
        .yt-timestamp-settings.light .browser-preview,
        .yt-timestamp-settings.light .sync-preview {
            background: rgba(255, 255, 255, 0.95);
            border: 1px solid rgba(0, 0, 0, 0.12);
        }

        .yt-timestamp-settings.light .player-representation {
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(0, 0, 0, 0.12);
        }

        .yt-timestamp-settings.light .format-label,
        .yt-timestamp-settings.light .theme-label,
        .yt-timestamp-settings.light .position-label,
        .yt-timestamp-settings.light .browser-name,
        .yt-timestamp-settings.light .sync-label {
            color: rgba(0, 0, 0, 0.87);
        }

        .yt-timestamp-settings.light .format-description,
        .yt-timestamp-settings.light .theme-description,
        .yt-timestamp-settings.light .position-description,
        .yt-timestamp-settings.light .browser-desc,
        .yt-timestamp-settings.light .sync-description {
            color: rgba(0, 0, 0, 0.6);
        }

        .yt-timestamp-settings.light .settings-tab {
            color: rgba(0, 0, 0, 0.7);
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .settings-tab:hover {
            background: rgba(0, 0, 0, 0.08);
            color: rgba(0, 0, 0, 0.87);
        }

        .yt-timestamp-settings.light .settings-tab.active {
            background: rgba(0, 0, 0, 0.08);
            color: var(--primary-color);
        }

        /* Light mode overrides for settings components */
        .yt-timestamp-settings.light {
            --text-primary: rgba(0, 0, 0, 0.87);
            --text-secondary: rgba(0, 0, 0, 0.6);
            --section-title: rgba(0, 0, 0, 0.87);
            --section-description: rgba(0, 0, 0, 0.6);
            --option-text: rgba(0, 0, 0, 0.87);
            --option-description: rgba(0, 0, 0, 0.6);
        }

        /* Section titles and descriptions */
        .yt-timestamp-settings.light .setting-label {
            color: var(--section-title);
        }

        .yt-timestamp-settings.light .setting-description {
            color: var(--section-description);
        }

        /* Notification Position */
        .yt-timestamp-settings.light .position-option {
            background: rgba(0, 0, 0, 0.04) !important;
        }

        .yt-timestamp-settings.light .position-option .position-label {
            color: var(--option-text);
        }

        .yt-timestamp-settings.light .position-option .position-description {
            color: var(--option-description);
        }

        .yt-timestamp-settings.light .position-option:hover {
            background: rgba(0, 0, 0, 0.08) !important;
        }

        .yt-timestamp-settings.light .position-option.active {
            background: rgba(0, 0, 0, 0.08) !important;
            border-color: var(--primary-color) !important;
        }

        /* Interface Theme */
        .yt-timestamp-settings.light .theme-option {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .theme-option .theme-label {
            color: var(--option-text);
        }

        .yt-timestamp-settings.light .theme-option .theme-description {
            color: var(--option-description);
        }

        .yt-timestamp-settings.light .theme-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .theme-option.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        /* Timestamp Format */
        .yt-timestamp-settings.light .format-option {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .format-option .format-label {
            color: var(--option-text);
        }

        .yt-timestamp-settings.light .format-option .format-description {
            color: var(--option-description);
        }

        .yt-timestamp-settings.light .format-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .format-option.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        /* Browser Presets */
        .yt-timestamp-settings.light .browser-preset {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .browser-preset .browser-name {
            color: var(--option-text);
        }

        .yt-timestamp-settings.light .browser-preset .browser-desc {
            color: var(--option-description);
        }

        .yt-timestamp-settings.light .browser-preset:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .browser-preset.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        /* Sync Options (Timestamp Conflict Resolution) */
        .yt-timestamp-settings.light .sync-option {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .sync-option .sync-label {
            color: var(--option-text);
        }

        .yt-timestamp-settings.light .sync-option .sync-description {
            color: var(--option-description);
        }

        .yt-timestamp-settings.light .sync-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .sync-option.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        /* Preview elements */
        .yt-timestamp-settings.light .format-preview,
        .yt-timestamp-settings.light .theme-preview,
        .yt-timestamp-settings.light .position-preview-container,
        .yt-timestamp-settings.light .browser-preview,
        .yt-timestamp-settings.light .sync-preview {
            background: rgba(255, 255, 255, 0.95);
            border: 1px solid rgba(0, 0, 0, 0.12);
        }

        /* Common hover and active states */
        .yt-timestamp-settings.light .format-option:hover,
        .yt-timestamp-settings.light .theme-option:hover,
        .yt-timestamp-settings.light .position-option:hover,
        .yt-timestamp-settings.light .browser-preset:hover,
        .yt-timestamp-settings.light .sync-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .format-option.active,
        .yt-timestamp-settings.light .theme-option.active,
        .yt-timestamp-settings.light .position-option.active,
        .yt-timestamp-settings.light .browser-preset.active,
        .yt-timestamp-settings.light .sync-option.active {
            background: rgba(0, 0, 0, 0.08);
            border-color: var(--primary-color);
        }

        /* Ensure text remains readable in preview containers */
        .yt-timestamp-settings.light .player-representation {
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(0, 0, 0, 0.12);
        }

        /* Fix for system theme preview text */
        .yt-timestamp-settings.light .theme-preview.system::before {
            color: white;
        }

        .yt-timestamp-settings.light .theme-preview.system::after {
            color: rgba(0, 0, 0, 0.87);
        }

        /* Ensure icon containers remain visible */
        .yt-timestamp-settings.light .notification-dot {
            background: var(--primary-color);
        }

        /* Fix for any monospace or example text */
        .yt-timestamp-settings.light .format-example {
            color: var(--option-text);
        }

        /* Ensure section headers are readable */
        .yt-timestamp-settings.light .settings-section-title {
            color: var(--section-title);
        }

        .yt-timestamp-settings.light .settings-section-description {
            color: var(--section-description);
        }

        /* Position Selector styles */
        .position-selector {
            display: flex;
            gap: var(--spacing-lg);
            width: 100%;
            padding: var(--spacing-md);
            background: var(--bg-secondary);
            border-radius: var(--border-radius-lg);
        }

        .position-state-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
        }

        .position-state-header {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs);
            padding: var(--spacing-sm) var(--spacing-md);
            background: var(--bg-hover);
            border-radius: var(--border-radius-md);
        }

        .position-state-icon {
            font-size: 16px;
            opacity: 0.9;
        }

        .position-grid-container {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
            padding: var(--spacing-md);
            background: var(--bg-hover);
            border-radius: var(--border-radius-md);
        }

        .position-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            aspect-ratio: 1;
            width: 180px;
            margin: 0 auto;
        }

        .position-option {
            width: 100%;
            aspect-ratio: 1;
            border-radius: var(--border-radius-sm);
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            cursor: pointer;
            transition: var(--transition-smooth);
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .position-option:hover {
            background: var(--bg-active);
            transform: scale(1.05);
        }

        .position-option.active {
            background: var(--primary-color);
            border-color: var(--primary-color);
            transform: scale(1.05);
        }

        .position-icon {
            font-size: 16px;
            opacity: 0.7;
            transition: var(--transition-smooth);
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
        }

        .position-option:hover .position-icon {
            opacity: 1;
        }

        .position-option.active .position-icon {
            opacity: 1;
            color: #ffffff;
        }

        /* Light mode overrides */
        .yt-timestamp-settings.light .position-option {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .position-option:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .position-option.active {
            background: var(--primary-color);
        }

        .yt-timestamp-settings.light .position-dot {
            background: rgba(0, 0, 0, 0.5);
        }

        .yt-timestamp-settings.light .position-option.active .position-dot {
            background: white;
        }

        .yt-timestamp-settings.light .position-state-tabs {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .position-state-tab {
            background: rgba(0, 0, 0, 0.04);
            color: rgba(0, 0, 0, 0.87);
        }

        .yt-timestamp-settings.light .position-state-tab:hover {
            background: rgba(0, 0, 0, 0.08);
        }

        .yt-timestamp-settings.light .position-state-tab.active {
            background: var(--primary-color);
            color: white;
        }

        .yt-timestamp-settings.light .margin-control {
            background: rgba(0, 0, 0, 0.04);
        }

        .yt-timestamp-settings.light .margin-control input {
            background: white;
            border-color: rgba(0, 0, 0, 0.1);
            color: rgba(0, 0, 0, 0.87);
        }

        .yt-timestamp-settings.light .margin-control input:focus {
            border-color: var(--primary-color);
            box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.1);
        }
    `;

    // Initialize styles
    GM_addStyle(styles);

    // Add theme variables container
    const addThemeContainer = () => {
        let themeContainer = document.querySelector('.yt-timestamp-theme-vars');
        if (!themeContainer) {
            themeContainer = document.createElement('div');
            themeContainer.className = 'yt-timestamp-theme-vars';
            themeContainer.style.display = 'none';
            document.body.appendChild(themeContainer);
        }
        return themeContainer;
    };

    // Update theme variables based on settings
    const updateThemeVariables = (isDarkMode) => {
        const themeContainer = addThemeContainer();

        // Determine if we should use dark mode based on themeMode setting
        let useDarkMode = true;

        if (settings.themeMode === 'light') {
            useDarkMode = false;
        } else if (settings.themeMode === 'system') {
            // Check system preference
            useDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        // Set colors based on theme
        const bgPrimary = useDarkMode ? 'rgba(25, 25, 25, 0.85)' : 'rgba(255, 255, 255, 0.95)';
        const bgSecondary = useDarkMode ? 'rgba(35, 35, 35, 0.85)' : 'rgba(245, 245, 245, 0.95)';
        const textPrimary = useDarkMode ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.9)';
        const textSecondary = useDarkMode ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.7)';
        const borderColor = useDarkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';

        themeContainer.style.setProperty('--bg-primary', bgPrimary);
        themeContainer.style.setProperty('--bg-secondary', bgSecondary);
        themeContainer.style.setProperty('--text-primary', textPrimary);
        themeContainer.style.setProperty('--text-secondary', textSecondary);
        themeContainer.style.setProperty('--border-color', borderColor);

        // Set accent color
        themeContainer.style.setProperty('--primary-color', settings.customAccentColor || '#2196F3');

        // Set blur effect based on blur amount
        const blurAmount = settings.blurAmount || 0;
        const blurValue = blurAmount > 0 ? `blur(${blurAmount}px) saturate(180%)` : 'none';
        themeContainer.style.setProperty('--blur-effect', blurValue);

        // Update UI variables
        document.documentElement.style.setProperty('--primary-color', settings.customAccentColor || '#2196F3');
        document.documentElement.style.setProperty('--blur-effect', blurValue);

        debug('Theme variables updated', {
            themeMode: settings.themeMode,
            systemIsDark: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
            usingDarkMode: useDarkMode,
            accentColor: settings.customAccentColor,
            blurAmount: blurAmount > 0 ? `${blurAmount}px` : 'disabled'
        });

        // Update any existing UI elements
        const settingsUI = document.querySelector('.yt-timestamp-settings');
        if (settingsUI) {
            settingsUI.className = `yt-timestamp-settings ${useDarkMode ? '' : 'light'} ${settingsUI.classList.contains('show') ? 'show' : ''}`;

            // Update all color-related elements to respect the accent color
            const accentElements = settingsUI.querySelectorAll('.settings-tab.active, input:checked + .modern-slider, .modern-input[type="range"]::-webkit-slider-thumb, .position-option.active, .format-option.active, .browser-preset.active, .size-option.active, .theme-option.active, .sync-option.active');
            accentElements.forEach(el => {
                if (el.classList.contains('modern-slider')) {
                    el.style.backgroundColor = settings.customAccentColor;
                } else if (el.classList.contains('theme-option')) {
                    if (el.classList.contains('active')) {
                    el.style.borderColor = settings.customAccentColor;
                    } else {
                        el.style.borderColor = 'transparent';
                    }
                } else if (el.classList.contains('format-option') || el.classList.contains('browser-preset') || el.classList.contains('size-option') || el.classList.contains('sync-option')) {
                    if (el.classList.contains('active')) {
                        el.style.borderColor = settings.customAccentColor;
                    }
                } else if (el.classList.contains('position-option') || el.classList.contains('screen-representation')) {
                    el.style.background = settings.customAccentColor;
                } else if (el.classList.contains('settings-tab')) {
                    el.style.color = settings.customAccentColor;
                    el.style.borderColor = settings.customAccentColor;
                }
            });
        }

        // Update notification container if it exists
        updateNotificationSettings(useDarkMode);
    };

    // Update notification settings to accept the isDarkMode parameter
    const updateNotificationSettings = (useDarkMode) => {
        if (!notificationContainer || !document.body.contains(notificationContainer)) {
            return; // No notification container to update
        }

        // Use provided dark mode value or determine from settings
        if (useDarkMode === undefined) {
            if (settings.themeMode === 'light') {
                useDarkMode = false;
            } else if (settings.themeMode === 'system') {
                useDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            } else {
                useDarkMode = true;
            }
        }

        // Update dark mode class
        notificationContainer.className = `yt-timestamp-notification ${useDarkMode ? '' : 'light'}`;

        // Update size
        if (settings.notificationSize === 'small') {
            notificationContainer.style.setProperty('--notification-width', 'clamp(160px, 18vw, 250px)');
            notificationContainer.style.fontSize = '10px';
        } else if (settings.notificationSize === 'large') {
            notificationContainer.style.setProperty('--notification-width', 'clamp(280px, 30vw, 400px)');
            notificationContainer.style.fontSize = '14px';
        } else {
            // Medium (default)
            notificationContainer.style.setProperty('--notification-width', 'clamp(220px, 24vw, 320px)');
            notificationContainer.style.fontSize = '12px';
        }

        // Fixed opacity (no longer user-configurable)
        notificationContainer.style.setProperty('--bg-opacity', '0.9');

        // Explicitly set the backdrop filter to respect blur setting
        const blurAmount = settings.blurAmount || 0;
        const blurValue = blurAmount > 0 ? `blur(${blurAmount}px) saturate(180%)` : 'none';
        notificationContainer.style.backdropFilter = blurValue;
        notificationContainer.style.webkitBackdropFilter = blurValue;

        // Update the progress bar color to match the accent color
        const progressBar = notificationContainer.querySelector('.notification-progress');
        if (progressBar) {
            progressBar.style.background = settings.customAccentColor;
        }

        // Update position (if notification is currently showing)
        if (notificationContainer.classList.contains('show')) {
            // Invalidate the cached rect to force position update
            lastPlayerRect = null;
            updateNotificationPosition(notificationContainer);
        }

        debug('Notification settings updated', {
            size: settings.notificationSize,
            blurAmount: blurAmount > 0 ? `${blurAmount}px` : 'disabled',
            darkMode: useDarkMode
        });
    };

    // Initialize theme variables
    updateThemeVariables();

    // Utility Functions
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        switch (settings.timestampFormat) {
            case 'seconds':
                return `${Math.floor(seconds)}s`;
            case 'mm:ss':
                return `${m}:${s.toString().padStart(2, '0')}`;
            case 'hh:mm:ss':
            default:
        return h > 0
            ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
            : `${m}:${s.toString().padStart(2, '0')}`;
        }
    };

    // Core Functions
    const getVideoId = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v');

        if (!videoId) return null;

        if (settings.removeTimestampFromURL && urlParams.has('t')) {
            urlParams.delete('t');
            const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
            window.history.replaceState({}, '', newUrl);
        }

        return videoId;
    };

    const saveTimestamp = (videoId, time, force = false) => {
        if (!videoId) return;

        const timestamps = GM_getValue('timestamps', {});
        const now = Date.now();
        const lastSave = timestamps[videoId]?.savedAt || 0;
        const timeSinceLastSave = (now - lastSave)/1000;
        const video = document.querySelector('video');

        // Handle paused video conditions
        if (!force && video && video.paused) {
            if (settings.saveOnPause) {
                debug('Video paused, saving position');
                force = true; // Force save on pause
            } else {
                debug('Skipping save - video is paused');
                return;
            }
        }

        // Throttle frequent saves
        if (!force && now - lastSave < settings.minSaveInterval * 1000) {
            return;
        }

        // Validate time value
        if (isNaN(time) || time < 0) {
            debug('Invalid time value, skipping save');
            return;
        }

        // Storage management - clean up old timestamps if exceeding limit
        const timestampEntries = Object.entries(timestamps);
        if (timestampEntries.length >= settings.maxStoredTimestamps) {
            debug(`Cleaning up timestamps - ${timestampEntries.length} exceeds limit of ${settings.maxStoredTimestamps}`);
            const sortedEntries = timestampEntries.sort((a, b) => b[1].savedAt - a[1].savedAt);
            const newTimestamps = Object.fromEntries(sortedEntries.slice(0, settings.maxStoredTimestamps - 1));
            GM_setValue('timestamps', newTimestamps);
            
            // Show cleanup notification
            if (force) {
                showNotification('Cleaned up old timestamps to make space', '🧹');
                setTimeout(() => saveTimestamp(videoId, time, force), 1500);
            } else {
                saveTimestamp(videoId, time, force);
            }
            return;
        }

        // Save the timestamp
        timestamps[videoId] = {
            time: time,
            savedAt: now,
            title: document.title.replace(' - YouTube', ''),
            duration: video?.duration || 0
        };

        GM_setValue('timestamps', timestamps);
        
        // Log with appropriate message type
        const saveSource = force ? 'Manual save' : 'Auto-save';
        debug(`${saveSource} for ${videoId} at ${formatTime(time)}`);

        // Show notifications based on settings and context
        if (force) {
            showNotification(`Saved at ${formatTime(time)}`, '💾');
        } else if (settings.notifyOnAutoSave) {
            showNotification(`Auto-saved at ${formatTime(time)}`, '⚡');
        }
    };

    const loadTimestamp = (videoId) => {
        if (!videoId) return null;

        const timestamps = GM_getValue('timestamps', {});
        const savedData = timestamps[videoId];

        if (!savedData) {
            debug(`No saved timestamp found for ${videoId}`);
            return null;
        }

        debug(`Found saved timestamp for ${videoId}: ${formatTime(savedData.time)}`);

        if (settings.smartTimestampHandling) {
            const urlParams = new URLSearchParams(window.location.search);
            const urlTime = urlParams.get('t');

            if (urlTime) {
                const timeMatch = urlTime.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
                if (timeMatch) {
                    const [, hours = 0, minutes = 0, seconds = 0] = timeMatch;
                    const urlTimeSeconds = (parseInt(hours) * 3600) + (parseInt(minutes) * 60) + parseInt(seconds);

                    // Only use URL time if significantly different from saved time
                    if (Math.abs(urlTimeSeconds - savedData.time) > 30) {
                        debug(`Using URL timestamp (${formatTime(urlTimeSeconds)}) instead of saved position (${formatTime(savedData.time)})`);
                        if (settings.restoreNotifications) {
                            showNotification('Using URL timestamp instead of saved position', '🔄');
                        }
                        return { time: urlTimeSeconds, savedAt: Date.now() };
                    }
                }
            }
        }

        // Check if saved position is near the end of video
        const video = document.querySelector('video');
        if (video && savedData.duration && savedData.time > savedData.duration - 30) {
            if (settings.restoreNotifications) {
                showNotification('Starting from beginning (previous position was near end)', '🔄');
            }
            return { time: 0, savedAt: Date.now() };
        }

        return savedData;
    };

    // UI Functions
    const getOrCreateNotificationContainer = () => {
        // If container exists and is in the DOM, verify it's properly structured
        if (notificationContainer && document.body.contains(notificationContainer)) {
            debug('Existing notification container found');
            
            // Verify the container has all required elements
            const contentDiv = notificationContainer.querySelector('.notification-content');
            const progressBar = notificationContainer.querySelector('.notification-progress');
            
            if (!contentDiv || !progressBar) {
                debug('Notification container missing required elements, recreating');
                try {
                    notificationContainer.parentNode.removeChild(notificationContainer);
                } catch (e) {
                    // Ignore errors if already detached
                }
                notificationContainer = null;
            } else {
                // Update dark mode state for existing container
                const useDarkMode = getDarkModeState();
                updateNotificationTheme(notificationContainer, useDarkMode);
            return notificationContainer;
            }
        } else if (notificationContainer) {
            debug('Notification container exists but is detached from DOM');
            notificationContainer = null;
        }

        debug('Creating new notification container');
        
        try {
            const containerId = 'yt-timestamp-notification-' + Date.now();
        notificationContainer = document.createElement('div');
            notificationContainer.id = containerId;

            // Get dark mode state
            const useDarkMode = getDarkModeState();

            // Set classes and initial styling
            notificationContainer.className = `yt-timestamp-notification ${useDarkMode ? 'dark' : 'light'}`;

            // Create content div
            const contentDiv = document.createElement('div');
            contentDiv.className = 'notification-content';
            contentDiv.style.display = 'flex';
            contentDiv.style.alignItems = 'center';
            contentDiv.style.gap = '8px';
            contentDiv.style.padding = '10px 12px';
            contentDiv.style.position = 'relative';
            contentDiv.style.width = 'fit-content';
            contentDiv.style.maxWidth = '100%';
            contentDiv.style.willChange = 'transform, opacity';
            notificationContainer.appendChild(contentDiv);

            // Create progress bar
            const progressBar = document.createElement('div');
            progressBar.className = 'notification-progress';
            progressBar.style.background = settings.customAccentColor;
            progressBar.style.height = '2px';
            progressBar.style.position = 'absolute';
            progressBar.style.bottom = '0';
            progressBar.style.left = '0';
            progressBar.style.right = '0';
            progressBar.style.opacity = '0.8';
            progressBar.style.transform = 'translateZ(0)';
            progressBar.style.willChange = 'width, opacity';
            progressBar.style.borderBottomLeftRadius = '6px';
            progressBar.style.borderBottomRightRadius = '6px';
            notificationContainer.appendChild(progressBar);

            // Apply modern styling with better aesthetics
            const darkModeStyles = {
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4), 0 0 1px rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                backgroundColor: 'rgba(32, 32, 32, 0.94)',
                color: 'rgba(255, 255, 255, 0.95)'
            };

            const lightModeStyles = {
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1)',
                border: '1px solid rgba(0, 0, 0, 0.08)',
                backgroundColor: 'rgba(255, 255, 255, 0.96)',
                color: 'rgba(0, 0, 0, 0.9)'
            };

            Object.assign(notificationContainer.style, {
                opacity: '0',
                pointerEvents: 'none',
                zIndex: '9999999',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                width: 'fit-content',
                maxWidth: 'min(90vw, 400px)',
                position: 'fixed',
                borderRadius: '6px',
                transform: 'translateZ(0) translateY(-10px) scale(0.96)',
                transition: 'all 0.2s cubic-bezier(0.2, 0, 0, 1)',
                backdropFilter: 'blur(10px)',
                webkitBackdropFilter: 'blur(10px)',
                ...(useDarkMode ? darkModeStyles : lightModeStyles)
            });
            
            // Set size based on settings
            if (settings.notificationSize === 'small') {
                notificationContainer.style.fontSize = '11px';
            } else if (settings.notificationSize === 'large') {
                notificationContainer.style.fontSize = '14px';
            } else {
                notificationContainer.style.fontSize = '13px';
            }
            
            // Remove any existing containers with the same ID
            const existingContainer = document.getElementById(containerId);
            if (existingContainer) {
                try {
                    existingContainer.parentNode.removeChild(existingContainer);
                } catch (e) {
                    // Ignore errors
                }
            }
            
            // Append to body
        document.body.appendChild(notificationContainer);
            
            // Ensure container was actually added to the DOM
            if (!document.body.contains(notificationContainer)) {
                debug('Error: Container failed to append to body, trying alternative method');
                document.body.insertAdjacentElement('beforeend', notificationContainer);
                
                if (!document.body.contains(notificationContainer)) {
                    debug('Critical error: Notification container could not be added to DOM');
                    return null;
                }
            }

            // Add theme change listener
            addThemeChangeListener(notificationContainer);
            
            debug(`Notification container created with ID: ${containerId}`);
        return notificationContainer;
        } catch (error) {
            console.error('Error creating notification container:', error);
            return null;
        }
    };

    // Helper function to get dark mode state
    const getDarkModeState = () => {
        if (settings.themeMode === 'light') {
            return false;
        } else if (settings.themeMode === 'system') {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
        return true; // Default to dark mode
    };

    // Helper function to update notification theme
    const updateNotificationTheme = (notification, isDark) => {
        if (!notification) return;

        // Update class
        notification.className = `yt-timestamp-notification ${isDark ? 'dark' : 'light'}`;

        // Update styles
        const themeStyles = isDark ? {
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4), 0 0 1px rgba(0, 0, 0, 0.3)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(32, 32, 32, 0.94)',
            color: 'rgba(255, 255, 255, 0.95)'
        } : {
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1)',
            border: '1px solid rgba(0, 0, 0, 0.08)',
            backgroundColor: 'rgba(255, 255, 255, 0.96)',
            color: 'rgba(0, 0, 0, 0.9)'
        };

        Object.assign(notification.style, themeStyles);

        // Update close button colors if present
        const closeButton = notification.querySelector('.notification-close');
        if (closeButton) {
            closeButton.addEventListener('mouseover', () => {
                closeButton.style.backgroundColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
            });
            closeButton.addEventListener('mouseout', () => {
                closeButton.style.backgroundColor = 'transparent';
            });
        }

        // Update emoji container background
        const emojiContainer = notification.querySelector('.notification-emoji-container');
        if (emojiContainer) {
            emojiContainer.style.background = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)';
        }
    };

    // Helper function to add theme change listener
    const addThemeChangeListener = (notification) => {
        if (settings.themeMode === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            const themeChangeHandler = (e) => {
                updateNotificationTheme(notification, e.matches);
            };
            
            // Add listener and store reference for cleanup
            mediaQuery.addListener(themeChangeHandler);
            notification.themeChangeHandler = themeChangeHandler;
            notification.mediaQuery = mediaQuery;
        }
    };

    // Position the notification based on settings and screen size
    const updateNotificationPosition = (notification) => {
        if (!notification) return;

        try {
            // Clear any styles from previous positioning
            notification.style.top = '';
            notification.style.right = '';
            notification.style.bottom = '';
            notification.style.left = '';
            notification.style.transform = '';
            
            // Enhanced video and player detection
            const video = document.querySelector('video');
            const playerElement = document.querySelector('#movie_player, ytd-player, .html5-video-player');
            const playerContainer = document.querySelector('ytd-watch-flexy');
            const theaterContainer = document.querySelector('ytd-watch-flexy[theater] #player-container');
            
            // Detect various player states
            const states = {
                isVideoPresent: !!video,
                isVideoPlaying: video && !video.paused && !video.ended && video.currentTime > 0,
                isFullscreen: document.fullscreenElement || document.webkitFullscreenElement,
                isTheaterMode: !!document.querySelector('ytd-watch-flexy[theater]'),
                isMiniPlayer: !!document.querySelector('.ytp-miniplayer-ui')
            };

            debug(`Positioning notification - States:`, states);

            // Get current state's position settings
            const stateSettings = states.isVideoPlaying ? 
                settings.notificationPosition.duringPlayback : 
                settings.notificationPosition.onHomepage;

            // Get position and margin from state settings
            const position = stateSettings.position;
            const baseMargin = stateSettings.margin;

            // Calculate responsive margins based on screen size and state margin
            const margin = {
                normal: baseMargin,
                fullscreen: Math.max(baseMargin, window.innerWidth * 0.02),
                safety: baseMargin * 0.5
            };

            // If no video or player is detected, use top-left position with padding
            if (!states.isVideoPresent || !playerElement) {
                debug('No video detected, using default top-left position');
                notification.style.top = `${margin.normal}px`;
                notification.style.left = `${margin.normal}px`;
                return;
            }
            
            // Get player dimensions
            const playerRect = playerElement.getBoundingClientRect();
            const containerRect = playerContainer?.getBoundingClientRect() || playerRect;
            
            // Handle fullscreen mode
            if (states.isFullscreen) {
                debug('Positioning for fullscreen video');
                applyFullscreenPosition(notification, position, margin.fullscreen);
                return;
            }

            // Handle theater mode
            if (states.isTheaterMode && theaterContainer) {
                debug('Positioning for theater mode');
                const theaterRect = theaterContainer.getBoundingClientRect();
                applyTheaterPosition(notification, position, theaterRect, margin.normal);
                return;
            }

            // Handle mini player
            if (states.isMiniPlayer) {
                debug('Positioning for mini player');
                notification.style.top = `${margin.normal}px`;
                notification.style.right = `${margin.normal}px`;
                return;
            }

            // Standard positioning relative to player
            debug('Applying standard positioning');
            applyStandardPosition(notification, position, playerRect, containerRect, margin.normal);

            // Ensure notification stays within viewport bounds
        requestAnimationFrame(() => {
            const notificationRect = notification.getBoundingClientRect();
                const viewportAdjustment = ensureInViewport(notificationRect, margin.safety);
                
                Object.entries(viewportAdjustment).forEach(([property, value]) => {
                    if (value !== null) {
                        notification.style[property] = value;
                    }
                });

                // Fix transform property if needed
                fixTransformProperty(notification);
            });

        } catch (error) {
            console.error('Error updating notification position:', error);
            // Fallback to safe position
            notification.style.top = `${margin.normal}px`;
            notification.style.left = `${margin.normal}px`;
        }
    };

    // Helper function for fullscreen positioning
    const applyFullscreenPosition = (notification, position, margin) => {
        const positions = {
            'top-left': { top: margin, left: margin },
            'top-center': { top: margin, left: '50%', transform: 'translateX(-50%)' },
            'top-right': { top: margin, right: margin },
            'center-left': { top: '50%', left: margin, transform: 'translateY(-50%)' },
            'center-center': { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
            'center-right': { top: '50%', right: margin, transform: 'translateY(-50%)' },
            'bottom-left': { bottom: margin, left: margin },
            'bottom-center': { bottom: margin, left: '50%', transform: 'translateX(-50%)' },
            'bottom-right': { bottom: margin, right: margin }
        };

        const pos = positions[position] || positions['top-right'];
        Object.entries(pos).forEach(([prop, value]) => {
            notification.style[prop] = typeof value === 'number' ? `${value}px` : value;
        });
    };

    // Helper function for theater mode positioning
    const applyTheaterPosition = (notification, position, theaterRect, margin) => {
        const positions = {
            'top-left': { top: theaterRect.top + margin, left: theaterRect.left + margin },
            'top-center': { top: theaterRect.top + margin, left: theaterRect.left + (theaterRect.width / 2), transform: 'translateX(-50%)' },
            'top-right': { top: theaterRect.top + margin, right: window.innerWidth - theaterRect.right + margin },
            'center-left': { top: theaterRect.top + (theaterRect.height / 2), left: theaterRect.left + margin, transform: 'translateY(-50%)' },
            'center-center': { top: theaterRect.top + (theaterRect.height / 2), left: theaterRect.left + (theaterRect.width / 2), transform: 'translate(-50%, -50%)' },
            'center-right': { top: theaterRect.top + (theaterRect.height / 2), right: window.innerWidth - theaterRect.right + margin, transform: 'translateY(-50%)' },
            'bottom-left': { bottom: window.innerHeight - theaterRect.bottom + margin, left: theaterRect.left + margin },
            'bottom-center': { bottom: window.innerHeight - theaterRect.bottom + margin, left: theaterRect.left + (theaterRect.width / 2), transform: 'translateX(-50%)' },
            'bottom-right': { bottom: window.innerHeight - theaterRect.bottom + margin, right: window.innerWidth - theaterRect.right + margin }
        };

        const pos = positions[position] || positions['top-right'];
        Object.entries(pos).forEach(([prop, value]) => {
            notification.style[prop] = typeof value === 'number' ? `${value}px` : value;
        });
    };

    // Helper function for standard positioning
    const applyStandardPosition = (notification, position, playerRect, containerRect, margin) => {
        const positions = {
            'top-left': { top: playerRect.top + margin, left: containerRect.left + margin },
            'top-center': { top: playerRect.top + margin, left: containerRect.left + (containerRect.width / 2), transform: 'translateX(-50%)' },
            'top-right': { top: playerRect.top + margin, right: window.innerWidth - containerRect.right + margin },
            'center-left': { top: playerRect.top + (playerRect.height / 2), left: containerRect.left + margin, transform: 'translateY(-50%)' },
            'center-center': { top: playerRect.top + (playerRect.height / 2), left: containerRect.left + (containerRect.width / 2), transform: 'translate(-50%, -50%)' },
            'center-right': { top: playerRect.top + (playerRect.height / 2), right: window.innerWidth - containerRect.right + margin, transform: 'translateY(-50%)' },
            'bottom-left': { bottom: window.innerHeight - playerRect.bottom + margin, left: containerRect.left + margin },
            'bottom-center': { bottom: window.innerHeight - playerRect.bottom + margin, left: containerRect.left + (containerRect.width / 2), transform: 'translateX(-50%)' },
            'bottom-right': { bottom: window.innerHeight - playerRect.bottom + margin, right: window.innerWidth - containerRect.right + margin }
        };

        const pos = positions[position] || positions['top-right'];
        Object.entries(pos).forEach(([prop, value]) => {
            notification.style[prop] = typeof value === 'number' ? `${value}px` : value;
        });
    };

    // Helper function to ensure notification stays within viewport
    const ensureInViewport = (rect, safetyMargin) => {
        const adjustment = {
            top: null,
            right: null,
            bottom: null,
            left: null,
            transform: null
        };

        if (rect.right > window.innerWidth - safetyMargin) {
            adjustment.right = `${safetyMargin}px`;
            adjustment.left = 'auto';
            adjustment.transform = '';
        }

        if (rect.left < safetyMargin) {
            adjustment.left = `${safetyMargin}px`;
            adjustment.right = 'auto';
            adjustment.transform = '';
        }

        if (rect.bottom > window.innerHeight - safetyMargin) {
            adjustment.bottom = `${safetyMargin}px`;
            adjustment.top = 'auto';
        }

        if (rect.top < safetyMargin) {
            adjustment.top = `${safetyMargin}px`;
            adjustment.bottom = 'auto';
        }

        return adjustment;
    };

    // Helper function to fix transform property
    const fixTransformProperty = (notification) => {
        const transform = notification.style.transform;
        if (!transform) return;

        if (transform.includes('translate(-50%,') && !transform.includes('translateY(-50%)')) {
            notification.style.transform = 'translateX(-50%)';
        } else if (transform.includes('translate(') && !transform.includes('translate(-50%, -50%)')) {
            notification.style.transform = transform
                .replace('translate(', 'translateX(')
                .replace(', -50%)', '');
        }
    };

    // Show notification with improved reliability and modern aesthetics
    const showNotification = (message, emoji, duration = settings.notificationDuration) => {
        if (!message || !emoji) {
            debug('Missing message or emoji for notification');
            return Promise.reject(new Error('Missing message or emoji'));
        }
        
        // Skip showing notification if notifications are disabled
        if (!settings.enableNotifications) {
            debug(`Notification suppressed (notifications disabled): ${message}`);
            return Promise.reject(new Error('Notifications disabled'));
        }

        // Skip duplicate notifications within a short time
        const notificationKey = `${message}:${emoji}`;
        const now = Date.now();
        const lastNotificationTime = showNotification.lastShownTimes?.get(notificationKey) || 0;
        
        if (now - lastNotificationTime < 1500) { // Prevent duplicate notifications within 1.5s
            debug('Skipping duplicate notification');
            return Promise.resolve(false);
        }

        // Update last shown time
        showNotification.lastShownTimes = showNotification.lastShownTimes || new Map();
        showNotification.lastShownTimes.set(notificationKey, now);
        
        debug(`Showing notification: ${message}`);
        
        // Return a promise to track success/failure
        return new Promise((resolve, reject) => {
            // Helper function to retry creating the notification if needed
            const showNotificationWithRetry = (retryCount = 0, maxRetries = 3) => {
            // Cancel any existing notification timers
            if (notificationTimeout) {
                clearTimeout(notificationTimeout);
                notificationTimeout = null;
            }

            if (notificationAnimationFrame) {
                cancelAnimationFrame(notificationAnimationFrame);
                notificationAnimationFrame = null;
            }

            // Get or create the notification container
            const notification = getOrCreateNotificationContainer();
            
            if (!notification) {
                if (retryCount < maxRetries) {
                    setTimeout(() => showNotificationWithRetry(retryCount + 1, maxRetries), 100);
                } else {
                    reject(new Error('Failed to create notification container'));
                }
                return;
            }

            const contentDiv = notification.querySelector('.notification-content');
            if (!contentDiv) {
                if (retryCount < maxRetries) {
                    setTimeout(() => showNotificationWithRetry(retryCount + 1, maxRetries), 100);
                } else {
                    reject(new Error('Failed to find content div'));
                }
                return;
            }

            // Clear existing content
            while (contentDiv.firstChild) {
                contentDiv.removeChild(contentDiv.firstChild);
            }

                // Create emoji container with enhanced styling
                const emojiContainer = document.createElement('div');
                emojiContainer.className = 'notification-emoji-container';
                emojiContainer.style.display = 'flex';
                emojiContainer.style.alignItems = 'center';
                emojiContainer.style.justifyContent = 'center';
                emojiContainer.style.flexShrink = '0';
                emojiContainer.style.borderRadius = '50%';
                emojiContainer.style.width = '22px';
                emojiContainer.style.height = '22px';
                emojiContainer.style.background = 'rgba(255, 255, 255, 0.1)';
                emojiContainer.style.marginRight = '4px';
                
                // Create emoji element with enhanced styling
            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'notification-emoji';
            emojiSpan.textContent = emoji;
                emojiSpan.style.fontSize = '14px';
                emojiSpan.style.lineHeight = '1';
            emojiSpan.style.display = 'flex';
            emojiSpan.style.alignItems = 'center';
            emojiSpan.style.justifyContent = 'center';
                emojiSpan.style.opacity = '0.95';
            emojiSpan.style.transform = 'translateZ(0)'; // Force GPU acceleration
            
                emojiContainer.appendChild(emojiSpan);
                
                // Create content container for better layout
                const textContainer = document.createElement('div');
                textContainer.className = 'notification-text-container';
                textContainer.style.display = 'flex';
                textContainer.style.flexDirection = 'column';
                textContainer.style.flexGrow = '1';
                textContainer.style.minWidth = '0'; // Allow ellipsis to work
                textContainer.style.gap = '2px';
                
                // Create message element with enhanced styling
            const messageSpan = document.createElement('span');
            messageSpan.className = 'notification-message';
            messageSpan.textContent = message;
            messageSpan.style.display = 'block';
                messageSpan.style.fontWeight = '500';  // Slightly bolder
                messageSpan.style.lineHeight = '1.2';
            messageSpan.style.whiteSpace = 'nowrap';
            messageSpan.style.overflow = 'hidden';
            messageSpan.style.textOverflow = 'ellipsis';
                messageSpan.style.opacity = '0.92';
            messageSpan.style.transform = 'translateZ(0)'; // Force GPU acceleration
                
                textContainer.appendChild(messageSpan);
                
                // Determine if we should use dark mode for styling
                let useDarkMode = true;
                if (settings.themeMode === 'light') {
                    useDarkMode = false;
                } else if (settings.themeMode === 'system') {
                    useDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                }
            
            // Add elements to content div
                contentDiv.appendChild(emojiContainer);
                contentDiv.appendChild(textContainer);
                
                // Add subtle close button
                const closeButton = document.createElement('div');
                closeButton.className = 'notification-close';
                closeButton.textContent = '×';  // Using textContent instead of innerHTML
                closeButton.style.fontSize = '16px';
                closeButton.style.lineHeight = '16px';
                closeButton.style.width = '16px';
                closeButton.style.height = '16px';
                closeButton.style.display = 'flex';
                closeButton.style.alignItems = 'center';
                closeButton.style.justifyContent = 'center';
                closeButton.style.marginLeft = '6px';
                closeButton.style.opacity = '0.5';
                closeButton.style.cursor = 'pointer';
                closeButton.style.borderRadius = '50%';
                closeButton.style.transition = 'opacity 0.2s ease, background-color 0.2s ease';
                
                // Add hover effect
                closeButton.addEventListener('mouseover', () => {
                    closeButton.style.opacity = '0.8';
                    closeButton.style.backgroundColor = useDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
                });
                
                closeButton.addEventListener('mouseout', () => {
                    closeButton.style.opacity = '0.5';
                    closeButton.style.backgroundColor = 'transparent';
                });
                
                // Add click handler to dismiss notification
                closeButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    hideNotification(notification, true);
                });
                
                contentDiv.appendChild(closeButton);

            // Position the notification before showing
            updateNotificationPosition(notification);

                // Show notification with enhanced animation
            requestAnimationFrame(() => {
                notification.style.display = 'flex';
                notification.style.visibility = 'visible';
                
                // Force a reflow to ensure transition works
                notification.offsetHeight;
                
                    // More sophisticated animation
                notification.style.opacity = '1';
                    notification.style.transform = 'translateZ(0) translateY(0) scale(1)';

                    // Start progress bar animation
                const progressBar = notification.querySelector('.notification-progress');
                if (progressBar) {
                        // Reset progress bar first
                        progressBar.style.transition = 'none';
                        progressBar.style.width = '100%';
                        
                        // Force reflow
                        progressBar.offsetHeight;
                        
                        // Start animation
                        progressBar.style.transition = `width ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
                        progressBar.style.width = '0';
                }

                // Set hide timeout
                notificationTimeout = setTimeout(() => {
                        hideNotification(notification);
                    }, duration);
                    
                    // Mark as resolved once shown
                    resolve(true);
                });
            };
            
            // Helper function to hide the notification with animation
            const hideNotification = (notification, immediate = false) => {
                if (!notification) return;
                
                const transitionDuration = immediate ? 150 : 250;
                
                // Set transition duration (faster for immediate)
                notification.style.transition = `all ${transitionDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
                
                // Animate out
                    notification.style.opacity = '0';
                notification.style.transform = 'translateZ(0) translateY(-10px) scale(0.96)';
                    
                    // Clean up after transition
                    setTimeout(() => {
                        notification.style.display = 'none';
                    
                        // Reset progress bar
                    const progressBar = notification.querySelector('.notification-progress');
                        if (progressBar) {
                            progressBar.style.transition = 'none';
                            progressBar.style.width = '100%';
                        }
                }, transitionDuration);
            };
            
            // Start the notification showing process
            showNotificationWithRetry(0, 3);
        });
    };

    // Debounced window resize handler
    window.addEventListener('resize', () => {
        if (resizeDebounceTimeout) {
            clearTimeout(resizeDebounceTimeout);
        }

        resizeDebounceTimeout = setTimeout(() => {
            if (notificationContainer && notificationContainer.classList.contains('show')) {
                requestAnimationFrame(() => {
                    updateNotificationPosition(notificationContainer);
                });
            }
            // Also invalidate cached player rect
            lastPlayerRect = null;
        }, 100); // 100ms debounce
    });

    // Optimized player change observer
    const observePlayerChanges = () => {
        debug('Setting up player change detection');
        
        // Function to find player container reliably
        const getPlayerContainer = () => {
            return document.querySelector('#movie_player') || 
                   document.querySelector('.html5-video-player');
        };

        const setupObserver = () => {
            const playerContainer = getPlayerContainer();
            if (!playerContainer) {
                debug('Player container not found, will retry later');
                return null;
            }
            
            // Create mutation observer
            const observer = new MutationObserver((mutations) => {
                if (!settings.debugMode) return; // Skip processing if not in debug mode
                
                for (const mutation of mutations) {
                    if (mutation.attributeName === 'class') {
                        const target = mutation.target;
                        const classes = target.className;
                        
                        if (classes.includes('playing')) {
                            debug('Player state changed: playing');
                        } else if (classes.includes('paused')) {
                            debug('Player state changed: paused');
                        }
                    }
                }
            });
            
            // Start observing with optimized configuration
            observer.observe(playerContainer, { 
                attributes: true,
                attributeFilter: ['class'], // Only observe class changes
                subtree: false // Don't observe children
            });
            
            debug('Player change observer initialized');
            return observer;
        };
        
        // Initial setup
        let observer = setupObserver();
        
        // If player not ready, retry with increasing delays
        if (!observer) {
            let retryCount = 0;
            const maxRetries = 5;
            const retryInterval = 1000;
            
            const retrySetup = () => {
                retryCount++;
                debug(`Retrying player observer setup (${retryCount}/${maxRetries})`);
                
                observer = setupObserver();
                if (!observer && retryCount < maxRetries) {
                    setTimeout(retrySetup, retryInterval * retryCount);
                }
            };
            
            setTimeout(retrySetup, retryInterval);
        }
        
        // Return cleanup function
        return {
            cleanup: () => {
                if (observer) {
                    observer.disconnect();
                    observer = null;
                    debug('Player observer cleaned up');
                }
            }
        };
    };

    // Initialize the player observer once
    observePlayerChanges();

    // Create settings UI Functions
    const createSettingOption = (id, label, description, type = 'checkbox') => {
        const option = document.createElement('div');
        option.className = 'setting-option';

        const header = document.createElement('div');
        header.className = 'setting-header';

        const labelElem = document.createElement('h3');
        labelElem.className = 'setting-label';
        labelElem.textContent = label;

        const descriptionElem = document.createElement('p');
        descriptionElem.className = 'setting-description';
        descriptionElem.textContent = description;

        const left = document.createElement('div');
        left.appendChild(labelElem);
        left.appendChild(descriptionElem);

        header.appendChild(left);

        const control = document.createElement('div');
        control.className = 'setting-control';

        switch (type) {
            case 'checkbox':
                const toggle = document.createElement('label');
                toggle.className = 'modern-toggle';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = id;
                checkbox.className = 'modern-input';
                checkbox.checked = settings[id] || false;

                // Instant update for checkboxes
                checkbox.addEventListener('change', () => {
                    settings[id] = checkbox.checked;
                    GM_setValue('ytTimestampSettings', settings);
                    updateThemeVariables();

                    // Show preview for certain setting changes
                    if (id === 'customNotificationIcons' || id === 'notifyOnRestore') {
                        showNotification(`${label} ${checkbox.checked ? 'enabled' : 'disabled'}`, '⚙️');
                    }
                });

                const slider = document.createElement('span');
                slider.className = 'modern-slider';

                toggle.appendChild(checkbox);
                toggle.appendChild(slider);
                control.appendChild(toggle);
                break;

            case 'number':
                const input = document.createElement('input');
                input.type = 'number';
                input.id = id;
                input.className = 'modern-input';
                input.value = settings[id] || 0;
                input.min = 0;

                // Instant update for number inputs
                input.addEventListener('change', () => {
                    const numValue = parseInt(input.value);
                    if (!isNaN(numValue)) {
                        settings[id] = numValue;
                        GM_setValue('ytTimestampSettings', settings);
                    }
                });

                control.appendChild(input);
                break;

            case 'select':
                const select = document.createElement('select');
                select.id = id;
                select.className = 'modern-select';

                // Instant update for selects
                select.addEventListener('change', () => {
                    if (id === 'preset') return; // Skip preset select as it has its own handler

                    settings[id] = select.value;
                    GM_setValue('ytTimestampSettings', settings);
                    updateThemeVariables();

                    // Show preview for notification changes
                    if (id === 'notificationSize') {
                        showNotification(`Notification size: ${select.value}`, '⚙️');
                    }
                });

                switch (id) {
                    case 'timestampFormat':
                        const formatSelector = document.createElement('div');
                        formatSelector.className = 'format-selector';
                        formatSelector.style.display = 'grid';
                        formatSelector.style.gridTemplateColumns = 'repeat(3, 1fr)';
                        formatSelector.style.gap = 'var(--spacing-md)';
                        formatSelector.style.width = '100%';

                        const formats = [
                            {
                                value: 'seconds',
                                label: 'Seconds',
                                description: 'Simple seconds format',
                                example: '123s',
                                icon: '⏱️'
                            },
                            {
                                value: 'mm:ss',
                                label: 'Minutes:Seconds',
                                description: 'Standard time format',
                                example: '2:03',
                                icon: '⌚'
                            },
                            {
                                value: 'hh:mm:ss',
                                label: 'Hours:Minutes:Seconds',
                                description: 'Full time format',
                                example: '1:02:03',
                                icon: '🕐'
                            }
                        ];

                        formats.forEach(format => {
                            const formatOption = document.createElement('div');
                            formatOption.className = `format-option ${settings.timestampFormat === format.value ? 'active' : ''}`;
                            formatOption.style.padding = 'var(--spacing-md)';
                            formatOption.style.borderRadius = 'var(--border-radius-md)';
                            formatOption.style.background = 'var(--bg-hover)';
                            formatOption.style.cursor = 'pointer';
                            formatOption.style.transition = 'var(--transition-smooth)';
                            formatOption.style.border = '2px solid transparent';
                            formatOption.style.display = 'flex';
                            formatOption.style.flexDirection = 'column';
                            formatOption.style.alignItems = 'center';
                            formatOption.style.gap = 'var(--spacing-sm)';

                            // Create preview container
                            const preview = document.createElement('div');
                            preview.className = 'format-preview';
                            preview.style.width = '100%';
                            preview.style.height = '60px';
                            preview.style.borderRadius = 'var(--border-radius-sm)';
                            preview.style.background = 'var(--bg-secondary)';
                            preview.style.border = '1px solid var(--border-color)';
                            preview.style.display = 'flex';
                            preview.style.alignItems = 'center';
                            preview.style.justifyContent = 'center';
                            preview.style.flexDirection = 'column';
                            preview.style.gap = '4px';
                            preview.style.marginBottom = 'var(--spacing-sm)';

                            // Add icon
                            const icon = document.createElement('div');
                            icon.textContent = format.icon;
                            icon.style.fontSize = '20px';
                            icon.style.marginBottom = '2px';

                            // Add example
                            const example = document.createElement('div');
                            example.textContent = format.example;
                            example.style.fontSize = '14px';
                            example.style.fontFamily = 'monospace';
                            example.style.color = 'var(--text-primary)';
                            example.style.opacity = '0.9';

                            preview.appendChild(icon);
                            preview.appendChild(example);

                            // Create label
                            const label = document.createElement('div');
                            label.className = 'format-label';
                            label.textContent = format.label;
                            label.style.fontWeight = '500';
                            label.style.color = 'var(--text-primary)';
                            label.style.fontSize = '14px';

                            // Create description
                            const description = document.createElement('div');
                            description.className = 'format-description';
                            description.textContent = format.description;
                            description.style.color = 'var(--text-secondary)';
                            description.style.fontSize = '12px';
                            description.style.textAlign = 'center';

                            formatOption.appendChild(preview);
                            formatOption.appendChild(label);
                            formatOption.appendChild(description);

                            // Add hover and active states
                            formatOption.addEventListener('mouseover', () => {
                                if (!formatOption.classList.contains('active')) {
                                    formatOption.style.background = 'var(--bg-active)';
                                    formatOption.style.transform = 'translateY(-2px)';
                                }
                            });

                            formatOption.addEventListener('mouseout', () => {
                                if (!formatOption.classList.contains('active')) {
                                    formatOption.style.background = 'var(--bg-hover)';
                                    formatOption.style.transform = 'none';
                                }
                            });

                            // Add click handler
                            formatOption.addEventListener('click', () => {
                                formatSelector.querySelectorAll('.format-option').forEach(opt => {
                                    opt.classList.remove('active');
                                    opt.style.background = 'var(--bg-hover)';
                                    opt.style.borderColor = 'transparent';
                                    opt.style.transform = 'none';
                                });

                                formatOption.classList.add('active');
                                formatOption.style.background = 'var(--bg-active)';
                                formatOption.style.borderColor = 'var(--primary-color)';
                                formatOption.style.transform = 'translateY(-2px)';

                                settings.timestampFormat = format.value;
                                GM_setValue('ytTimestampSettings', settings);

                                // Show preview with the new format
                                const now = Math.floor(Date.now() / 1000);
                                const formattedTime = formatTime(now, format.value);
                                showNotification(`Format set to ${format.label}\n${formattedTime}`, format.icon);
                            });

                            // Set initial active state
                            if (settings.timestampFormat === format.value) {
                                formatOption.classList.add('active');
                                formatOption.style.background = 'var(--bg-active)';
                                formatOption.style.borderColor = 'var(--primary-color)';
                            }

                            formatSelector.appendChild(formatOption);
                        });

                        control.appendChild(formatSelector);
                        control.style.width = '100%';
                        break;

                    case 'notificationPosition':
                        // This is now handled by the position picker visual representation
                        // so we don't create a dropdown here
                        break;

                    case 'syncBehavior':
                        const behaviors = [
                            { value: 'latest', label: 'Use latest position' },
                            { value: 'manual', label: 'Manual selection' }
                        ];
                        behaviors.forEach(behavior => {
                            const option = document.createElement('option');
                            option.value = behavior.value;
                            option.textContent = behavior.label;
                            option.selected = settings[id] === behavior.value;
                            select.appendChild(option);
                        });
                        break;

                    case 'notificationSize':
                        const sizes = [
                            { value: 'small', label: 'Compact' },
                            { value: 'medium', label: 'Standard' },
                            { value: 'large', label: 'Spacious' }
                        ];
                        sizes.forEach(size => {
                            const option = document.createElement('option');
                            option.value = size.value;
                            option.textContent = size.label;
                            option.selected = settings[id] === size.value;
                            select.appendChild(option);
                        });
                        break;

                    case 'preset':
                        const presets = [
                            { value: 'custom', label: 'Custom' },
                            { value: 'chrome', label: 'Chrome Preset' },
                            { value: 'firefox', label: 'Firefox Preset' }
                        ];
                        presets.forEach(presetOption => {
                            const option = document.createElement('option');
                            option.value = presetOption.value;
                            option.textContent = presetOption.label;
                            option.selected = settings[id] === presetOption.value;
                            select.appendChild(option);
                        });

                        // Add event listener for preset changes
                        select.addEventListener('change', () => {
                            applyPreset(select.value);
                        });
                        break;
                }

                // Only append select if it has children (notificationPosition doesn't)
                if (select.children.length > 0) {
                    control.appendChild(select);
                }
                break;

            case 'time-input':
                const rangeContainer = document.createElement('div');
                rangeContainer.style.display = 'flex';
                rangeContainer.style.alignItems = 'center';
                rangeContainer.style.gap = 'var(--spacing-md)';
                rangeContainer.style.width = '100%';

                const range = document.createElement('input');
                range.type = 'range';
                range.id = id;
                range.className = 'modern-input';

                // Set appropriate min/max based on the setting
                if (id === 'notificationDuration') {
                    range.min = '1000';
                    range.max = '10000';
                    range.step = '500';
                    range.value = settings[id] || 3000;
                } else if (id === 'saveInterval') {
                    range.min = '1';
                    range.max = '30';
                    range.step = '1';
                    range.value = settings[id] || 5;
                } else if (id === 'minSaveInterval') {
                    range.min = '5';
                    range.max = '120';
                    range.step = '5';
                    range.value = settings[id] || 30;
                } else if (id === 'notificationOpacity') {
                    range.min = '10';
                    range.max = '100';
                    range.step = '5';
                    range.value = settings[id] || 90;
                } else if (id === 'blurAmount') {
                    range.min = '0';
                    range.max = '40';
                    range.step = '2';
                    range.value = settings[id] || 24;
                } else {
                    range.min = '0';
                    range.max = '100';
                    range.value = settings[id] || 50;
                }

                const valueContainer = document.createElement('div');
                valueContainer.style.minWidth = '80px';
                valueContainer.style.textAlign = 'center';
                valueContainer.style.padding = 'var(--spacing-sm)';
                valueContainer.style.background = 'var(--bg-hover)';
                valueContainer.style.borderRadius = 'var(--border-radius-sm)';
                valueContainer.style.fontWeight = 'bold';

                const value = document.createElement('span');
                if (id === 'notificationDuration') {
                    value.textContent = `${range.value / 1000}s`;
                } else if (id === 'notificationOpacity') {
                    value.textContent = `${range.value}%`;
                } else if (id === 'blurAmount') {
                    value.textContent = range.value > 0 ? `${range.value}px` : 'Off';
                } else {
                    value.textContent = `${range.value}s`;
                }
                valueContainer.appendChild(value);

                range.oninput = () => {
                    if (id === 'notificationDuration') {
                        value.textContent = `${range.value / 1000}s`;
                    } else if (id === 'notificationOpacity') {
                        value.textContent = `${range.value}%`;
                    } else if (id === 'blurAmount') {
                        value.textContent = range.value > 0 ? `${range.value}px` : 'Off';
                    } else {
                        value.textContent = `${range.value}s`;
                    }

                    // Instantly apply changes for ranges
                    settings[id] = parseInt(range.value);
                    GM_setValue('ytTimestampSettings', settings);

                    // Update theme immediately
                    updateThemeVariables();

                    // Show preview for certain setting changes
                    if (id === 'notificationOpacity') {
                        // Force update opacity immediately
                        if (notificationContainer) {
                            notificationContainer.style.setProperty('--bg-opacity', (range.value / 100).toString());
                        }
                        showNotification('Opacity preview: ' + range.value + '%', '⚙️');
                    } else if (id === 'blurAmount') {
                        // Update blur immediately and show preview
                        if (notificationContainer) {
                            const blurValue = range.value > 0 ? `blur(${range.value}px) saturate(180%)` : 'none';
                            notificationContainer.style.backdropFilter = blurValue;
                            notificationContainer.style.webkitBackdropFilter = blurValue;
                        }
                        const blurStatus = range.value > 0 ? `${range.value}px` : 'disabled';
                        showNotification(`Blur effect: ${blurStatus}`, '🔍');
                    } else if (id === 'notificationDuration') {
                        showNotification(`Duration: ${range.value / 1000} seconds`, '⏱️');
                    }
                };

                rangeContainer.appendChild(range);
                rangeContainer.appendChild(valueContainer);
                control.appendChild(rangeContainer);
                break;

            case 'percent-slider':
                const percentContainer = document.createElement('div');
                percentContainer.style.display = 'flex';
                percentContainer.style.alignItems = 'center';
                percentContainer.style.gap = 'var(--spacing-md)';
                percentContainer.style.width = '100%';

                const percentRange = document.createElement('input');
                percentRange.type = 'range';
                percentRange.id = id;
                percentRange.className = 'modern-input';
                percentRange.min = '10';
                percentRange.max = '100';
                percentRange.step = '5';
                percentRange.value = settings[id] || 90;

                const percentValueContainer = document.createElement('div');
                percentValueContainer.style.minWidth = '80px';
                percentValueContainer.style.textAlign = 'center';
                percentValueContainer.style.padding = 'var(--spacing-sm)';
                percentValueContainer.style.background = 'var(--bg-hover)';
                percentValueContainer.style.borderRadius = 'var(--border-radius-sm)';
                percentValueContainer.style.fontWeight = 'bold';

                const percentValue = document.createElement('span');
                percentValue.textContent = `${percentRange.value}%`;
                percentValueContainer.appendChild(percentValue);

                percentRange.oninput = () => {
                    percentValue.textContent = `${percentRange.value}%`;

                    // Instantly apply changes
                    settings[id] = parseInt(percentRange.value);
                    GM_setValue('ytTimestampSettings', settings);

                    // Update theme immediately
                    updateThemeVariables();

                    // Show preview for opacity changes
                    if (id === 'notificationOpacity') {
                        // Force update opacity immediately
                        if (notificationContainer) {
                            notificationContainer.style.setProperty('--bg-opacity', (percentRange.value / 100).toString());
                        }
                        showNotification('Opacity preview: ' + percentRange.value + '%', '⚙️');
                    }
                };

                percentContainer.appendChild(percentRange);
                percentContainer.appendChild(percentValueContainer);
                control.appendChild(percentContainer);
                break;

            case 'format-selector':
                // Create a visual format selector with examples
                const formatContainer = document.createElement('div');
                formatContainer.style.display = 'grid';
                formatContainer.style.gap = 'var(--spacing-sm)';
                formatContainer.style.gridTemplateColumns = 'repeat(3, 1fr)';

                const formats = [
                    { value: 'seconds', label: 'Seconds', example: '123s' },
                    { value: 'mm:ss', label: 'Minutes:Seconds', example: '2:03' },
                    { value: 'hh:mm:ss', label: 'Hours:Minutes:Seconds', example: '1:02:03' }
                ];

                formats.forEach(format => {
                    const formatOption = document.createElement('div');
                    formatOption.className = `format-option ${settings.timestampFormat === format.value ? 'active' : ''}`;
                    formatOption.style.padding = 'var(--spacing-sm)';
                    formatOption.style.borderRadius = 'var(--border-radius-sm)';
                    formatOption.style.background = 'var(--bg-hover)';
                    formatOption.style.cursor = 'pointer';
                    formatOption.style.textAlign = 'center';
                    formatOption.style.transition = 'var(--transition-smooth)';
                    formatOption.style.border = '2px solid transparent';

                    if (settings.timestampFormat === format.value) {
                        formatOption.style.borderColor = 'var(--primary-color)';
                        formatOption.style.background = 'var(--bg-active)';
                    }

                    const formatLabel = document.createElement('div');
                    formatLabel.textContent = format.label;
                    formatLabel.style.fontWeight = 'bold';

                    const formatExample = document.createElement('div');
                    formatExample.textContent = format.example;
                    formatExample.style.color = 'var(--text-secondary)';
                    formatExample.style.fontSize = '13px';
                    formatExample.style.marginTop = '4px';

                    formatOption.appendChild(formatLabel);
                    formatOption.appendChild(formatExample);

                    formatOption.addEventListener('click', () => {
                        formatContainer.querySelectorAll('.format-option').forEach(opt => {
                            opt.style.borderColor = 'transparent';
                            opt.style.background = 'var(--bg-hover)';
                            opt.classList.remove('active');
                        });

                        formatOption.style.borderColor = 'var(--primary-color)';
                        formatOption.style.background = 'var(--bg-active)';
                        formatOption.classList.add('active');

                        settings.timestampFormat = format.value;
                        GM_setValue('ytTimestampSettings', settings);
                    });

                    formatContainer.appendChild(formatOption);
                });

                control.appendChild(formatContainer);
                break;

            case 'color':
                const colorPicker = document.createElement('div');
                colorPicker.className = 'color-picker';
                const colors = ['#2196F3', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4', '#EC4899', '#6366F1'];

                colors.forEach(color => {
                    const colorOption = document.createElement('div');
                    colorOption.className = `color-option ${settings[id] === color ? 'active' : ''}`;
                    colorOption.style.backgroundColor = color;

                    // Apply active styling
                    if (settings[id] === color) {
                        colorOption.style.border = '2px solid var(--text-primary)';
                        colorOption.style.transform = 'scale(1.1)';
                    } else {
                        colorOption.style.border = '2px solid transparent';
                    }

                    colorOption.onclick = () => {
                        colorPicker.querySelectorAll('.color-option').forEach(opt => {
                            opt.classList.remove('active');
                            opt.style.border = '2px solid transparent';
                            opt.style.transform = 'none';
                        });

                        colorOption.classList.add('active');
                        colorOption.style.border = '2px solid var(--text-primary)';
                        colorOption.style.transform = 'scale(1.1)';

                        // Update setting and apply immediately
                        settings[id] = color;
                        GM_setValue('ytTimestampSettings', settings);

                        // Force update to DOM properties directly
                        document.documentElement.style.setProperty('--primary-color', color);

                        // Update any UI elements using the accent color
                        const settingsUI = document.querySelector('.yt-timestamp-settings');
                        if (settingsUI) {
                            const accentElements = settingsUI.querySelectorAll('.settings-tab.active, input:checked + .modern-slider, .modern-input[type="range"]::-webkit-slider-thumb, .position-option.active, .format-option.active, .browser-preset.active, .size-option.active, .theme-option.active, .sync-option.active');
                            accentElements.forEach(el => {
                                if (el.classList.contains('modern-slider')) {
                                    el.style.backgroundColor = color;
                                } else if (el.classList.contains('theme-option')) {
                                    if (el.classList.contains('active')) {
                                    el.style.borderColor = color;
                                    } else {
                                        el.style.borderColor = 'transparent';
                                    }
                                } else if (el.classList.contains('format-option') || el.classList.contains('browser-preset') || el.classList.contains('size-option') || el.classList.contains('sync-option')) {
                                    if (el.classList.contains('active')) {
                                        el.style.borderColor = color;
                                    }
                                } else if (el.classList.contains('position-option') || el.classList.contains('screen-representation')) {
                                    el.style.background = color;
                                } else if (el.classList.contains('settings-tab')) {
                                    el.style.color = color;
                                    el.style.borderColor = color;
                                }
                            });
                        }

                        // Update the notification container colors
                        if (notificationContainer) {
                            const progressBar = notificationContainer.querySelector('.notification-progress');
                            if (progressBar) {
                                progressBar.style.background = color;
                            }
                        }

                        // Immediately update theme variables to reflect color change
                        updateThemeVariables();

                        // Show a notification with the new color
                        showNotification('Accent color updated', '🎨');
                    };
                    colorPicker.appendChild(colorOption);
                });

                control.appendChild(colorPicker);
                break;

            case 'hotkey':
                const hotkeyInput = document.createElement('input');
                hotkeyInput.type = 'text';
                hotkeyInput.id = id;
                hotkeyInput.className = 'modern-input';
                hotkeyInput.value = settings[id] || '';
                hotkeyInput.placeholder = 'Click to set hotkey';
                hotkeyInput.readOnly = true;

                hotkeyInput.addEventListener('focus', function() {
                    this.value = '';
                    this.placeholder = 'Press key combination...';
                });

                hotkeyInput.addEventListener('keydown', function(e) {
                    e.preventDefault();

                    const keyCombo = [];
                    if (e.ctrlKey) keyCombo.push('CTRL');
                    if (e.altKey) keyCombo.push('ALT');
                    if (e.shiftKey) keyCombo.push('SHIFT');

                    if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
                        keyCombo.push(e.key.toUpperCase());
                        this.value = keyCombo.join('+');

                        // Save the hotkey immediately
                        settings[id] = this.value;
                        GM_setValue('ytTimestampSettings', settings);

                        this.blur();
                    }
                });

                hotkeyInput.addEventListener('blur', function() {
                    if (!this.value) {
                        this.placeholder = 'Click to set hotkey';
                    }
                });

                control.appendChild(hotkeyInput);
                break;

            case 'position-picker':
                const positionSelector = document.createElement('div');
                positionSelector.className = 'position-selector';
                positionSelector.style.display = 'flex';
                positionSelector.style.gap = 'var(--spacing-lg)';
                positionSelector.style.width = '100%';
                positionSelector.style.padding = 'var(--spacing-md)';
                positionSelector.style.background = 'var(--bg-secondary)';
                positionSelector.style.borderRadius = 'var(--border-radius-lg)';

                // Create containers for both states
                const states = [
                    { 
                        id: 'duringPlayback', 
                        label: 'During Playback', 
                        icon: '▶️', 
                        description: 'Controls notification position while watching videos on a watch page. Applies when video is playing.'
                    },
                    { 
                        id: 'onHomepage', 
                        label: 'On Homepage', 
                        icon: '🏠', 
                        description: 'Controls notification position while browsing the YouTube homepage or when no video is playing.'
                    }
                ];

                states.forEach(state => {
                    const stateContainer = document.createElement('div');
                    stateContainer.className = 'position-state-container';
                    stateContainer.style.flex = '1';
                    stateContainer.style.display = 'flex';
                    stateContainer.style.flexDirection = 'column';
                    stateContainer.style.gap = 'var(--spacing-md)';

                    // Create state header with description
                    const stateHeader = document.createElement('div');
                    stateHeader.className = 'position-state-header';
                    stateHeader.style.display = 'flex';
                    stateHeader.style.flexDirection = 'column';
                    stateHeader.style.gap = 'var(--spacing-xs)';
                    stateHeader.style.padding = 'var(--spacing-sm) var(--spacing-md)';
                    stateHeader.style.background = 'var(--bg-hover)';
                    stateHeader.style.borderRadius = 'var(--border-radius-md)';

                    const headerTitle = document.createElement('div');
                    headerTitle.style.display = 'flex';
                    headerTitle.style.alignItems = 'center';
                    headerTitle.style.gap = 'var(--spacing-sm)';
                    headerTitle.style.fontWeight = '500';
                    headerTitle.style.fontSize = '14px';

                    const stateIcon = document.createElement('span');
                    stateIcon.className = 'position-state-icon';
                    stateIcon.textContent = state.icon;
                    stateIcon.style.fontSize = '16px';
                    stateIcon.style.opacity = '0.9';

                    const stateLabel = document.createElement('span');
                    stateLabel.textContent = state.label;

                    headerTitle.appendChild(stateIcon);
                    headerTitle.appendChild(stateLabel);

                    const stateDescription = document.createElement('div');
                    stateDescription.textContent = state.description;
                    stateDescription.style.fontSize = '12px';
                    stateDescription.style.color = 'var(--text-secondary)';
                    stateDescription.style.marginTop = '2px';
                    stateDescription.style.lineHeight = '1.4';

                    stateHeader.appendChild(headerTitle);
                    stateHeader.appendChild(stateDescription);
                    stateContainer.appendChild(stateHeader);

                    // Create grid container
                    const gridContainer = document.createElement('div');
                    gridContainer.className = 'position-grid-container';
                    gridContainer.style.display = 'flex';
                    gridContainer.style.flexDirection = 'column';
                    gridContainer.style.gap = 'var(--spacing-md)';
                    gridContainer.style.padding = 'var(--spacing-md)';
                    gridContainer.style.background = 'var(--bg-hover)';
                    gridContainer.style.borderRadius = 'var(--border-radius-md)';

                    // Create position grid
                    const positionGrid = document.createElement('div');
                    positionGrid.className = 'position-grid';
                    positionGrid.style.display = 'grid';
                    positionGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
                    positionGrid.style.gap = '8px';
                    positionGrid.style.aspectRatio = '1';
                    positionGrid.style.width = '180px';
                    positionGrid.style.margin = '0 auto';
                    positionGrid.style.border = 'none'; // Remove dotted border

                const positions = [
                        { value: 'top-left', icon: '↖️', label: 'Top Left' },
                        { value: 'top-center', icon: '⬆️', label: 'Top Center' },
                        { value: 'top-right', icon: '↗️', label: 'Top Right' },
                        { value: 'center-left', icon: '⬅️', label: 'Center Left' },
                        { value: 'center-center', icon: '⏺️', label: 'Center' },
                        { value: 'center-right', icon: '➡️', label: 'Center Right' },
                        { value: 'bottom-left', icon: '↙️', label: 'Bottom Left' },
                        { value: 'bottom-center', icon: '⬇️', label: 'Bottom Center' },
                        { value: 'bottom-right', icon: '↘️', label: 'Bottom Right' }
                ];

                positions.forEach(position => {
                    const positionOption = document.createElement('div');
                        positionOption.className = `position-option ${settings.notificationPosition[state.id]?.position === position.value ? 'active' : ''}`;
                    positionOption.dataset.position = position.value;
                        positionOption.style.width = '100%';
                        positionOption.style.aspectRatio = '1';
                        positionOption.style.borderRadius = 'var(--border-radius-sm)';
                        positionOption.style.background = 'var(--bg-primary)';
                        positionOption.style.border = '1px solid var(--border-color)';
                        positionOption.style.cursor = 'pointer';
                        positionOption.style.transition = 'var(--transition-smooth)';
                        positionOption.style.position = 'relative';
                        positionOption.style.display = 'flex';
                        positionOption.style.alignItems = 'center';
                        positionOption.style.justifyContent = 'center';
                        positionOption.style.overflow = 'hidden';
                        positionOption.style.padding = '0'; // Ensure no padding affects icon size

                        // Create icon container with fixed size
                        const iconContainer = document.createElement('div');
                        iconContainer.className = 'position-icon';
                        iconContainer.style.width = '16px'; // Fixed size for icon
                        iconContainer.style.height = '16px';
                        iconContainer.style.fontSize = '14px'; // Slightly smaller icon
                        iconContainer.style.opacity = '0.7';
                        iconContainer.style.transition = 'var(--transition-smooth)';
                        iconContainer.style.display = 'flex';
                        iconContainer.style.alignItems = 'center';
                        iconContainer.style.justifyContent = 'center';
                        iconContainer.style.transform = 'translateZ(0)'; // Force GPU acceleration
                        iconContainer.textContent = position.icon;

                        // Add tooltip with position name
                        positionOption.title = position.label;

                        positionOption.appendChild(iconContainer);

                        // Add hover effect
                        positionOption.addEventListener('mouseover', () => {
                            positionOption.style.background = 'var(--bg-active)';
                            positionOption.style.transform = 'scale(1.05)';
                            iconContainer.style.opacity = '1';
                        });

                        positionOption.addEventListener('mouseout', () => {
                            if (!positionOption.classList.contains('active')) {
                                positionOption.style.background = 'var(--bg-primary)';
                                positionOption.style.transform = 'none';
                                iconContainer.style.opacity = '0.7';
                            }
                        });

                    // Add click handler
                    positionOption.addEventListener('click', () => {
                            // Update visual state of all options
                            positionGrid.querySelectorAll('.position-option').forEach(opt => {
                            opt.classList.remove('active');
                                opt.style.background = 'var(--bg-primary)';
                                opt.style.transform = 'none';
                                opt.style.borderColor = 'var(--border-color)';
                                opt.querySelector('.position-icon').style.opacity = '0.7';
                        });

                            // Update selected option appearance
                        positionOption.classList.add('active');
                            positionOption.style.background = settings.customAccentColor;
                            positionOption.style.transform = 'scale(1.05)';
                        positionOption.style.borderColor = settings.customAccentColor;
                            iconContainer.style.opacity = '1';
                            iconContainer.style.color = '#ffffff';

                            // Update settings
                            if (!settings.notificationPosition[state.id]) {
                                settings.notificationPosition[state.id] = {};
                            }
                            settings.notificationPosition[state.id].position = position.value;
                        GM_setValue('ytTimestampSettings', settings);

                        // Show preview notification
                            showNotification(`${state.label} notifications will appear in the ${position.label.toLowerCase()}`, '📍')
                                .then(() => {
                                    // Force update notification position for any visible notifications
                                    if (notificationContainer && notificationContainer.classList.contains('show')) {
                                        updateNotificationPosition(notificationContainer);
                                    }
                                });
                        });

                        // Set initial active state
                        if (settings.notificationPosition[state.id]?.position === position.value) {
                            positionOption.style.background = settings.customAccentColor;
                        positionOption.style.borderColor = settings.customAccentColor;
                            iconContainer.style.opacity = '1';
                            iconContainer.style.color = '#ffffff';
                        }

                        positionGrid.appendChild(positionOption);
                    });

                    gridContainer.appendChild(positionGrid);
                    stateContainer.appendChild(gridContainer);
                    positionSelector.appendChild(stateContainer);
                });
                
                control.appendChild(positionSelector);
                control.style.width = '100%';
                break;

            case 'browser-preset-selector':
                const presetSelector = document.createElement('div');
                presetSelector.className = 'preset-selector';
                presetSelector.style.display = 'grid';
                presetSelector.style.gridTemplateColumns = 'repeat(3, 1fr)';
                presetSelector.style.gap = 'var(--spacing-md)';
                presetSelector.style.width = '100%';

                const presets = [
                    {
                        id: 'custom',
                        name: 'Custom',
                        description: 'Keep your current settings',
                        icon: '🛠️',
                        accent: settings.customAccentColor
                    },
                    {
                        id: 'chrome',
                        name: 'Chrome',
                        description: 'Chrome-styled with blue accent',
                        icon: '🌐',
                        accent: '#4285F4'
                    },
                    {
                        id: 'firefox',
                        name: 'Firefox',
                        description: 'Firefox-styled with orange accent',
                        icon: '🦊',
                        accent: '#FF9500'
                    }
                ];

                presets.forEach(preset => {
                    const presetOption = document.createElement('div');
                    presetOption.className = `preset-option ${settings.preset === preset.id ? 'active' : ''}`;
                    presetOption.style.padding = 'var(--spacing-md)';
                    presetOption.style.borderRadius = 'var(--border-radius-md)';
                    presetOption.style.background = 'var(--bg-hover)';
                    presetOption.style.cursor = 'pointer';
                    presetOption.style.transition = 'var(--transition-smooth)';
                    presetOption.style.border = '2px solid transparent';
                    presetOption.style.display = 'flex';
                    presetOption.style.flexDirection = 'column';
                    presetOption.style.alignItems = 'center';
                    presetOption.style.gap = 'var(--spacing-sm)';

                    // Create preview container
                    const preview = document.createElement('div');
                    preview.className = 'preset-preview';
                    preview.style.width = '100%';
                    preview.style.height = '80px';
                    preview.style.borderRadius = 'var(--border-radius-sm)';
                    preview.style.background = 'var(--bg-secondary)';
                    preview.style.border = '1px solid var(--border-color)';
                    preview.style.display = 'flex';
                    preview.style.alignItems = 'center';
                    preview.style.justifyContent = 'center';
                    preview.style.position = 'relative';
                    preview.style.overflow = 'hidden';
                    preview.style.marginBottom = 'var(--spacing-sm)';

                    // Create accent color bar
                    const accentBar = document.createElement('div');
                    accentBar.style.position = 'absolute';
                    accentBar.style.bottom = '0';
                    accentBar.style.left = '0';
                    accentBar.style.width = '100%';
                    accentBar.style.height = '4px';
                    accentBar.style.background = preset.accent;
                    accentBar.style.opacity = '0.8';

                    // Create icon container
                    const iconContainer = document.createElement('div');
                    iconContainer.style.width = '40px';
                    iconContainer.style.height = '40px';
                    iconContainer.style.borderRadius = '50%';
                    iconContainer.style.background = preset.accent;
                    iconContainer.style.display = 'flex';
                    iconContainer.style.alignItems = 'center';
                    iconContainer.style.justifyContent = 'center';
                    iconContainer.style.fontSize = '24px';
                    iconContainer.style.color = '#ffffff';
                    iconContainer.style.boxShadow = '0 2px 8px ' + preset.accent + '80';
                    iconContainer.textContent = preset.icon;

                    preview.appendChild(iconContainer);
                    preview.appendChild(accentBar);

                    // Create name label
                    const name = document.createElement('div');
                    name.className = 'preset-name';
                    name.textContent = preset.name;
                    name.style.fontWeight = '500';
                    name.style.color = 'var(--text-primary)';
                    name.style.fontSize = '14px';

                    // Create description
                    const description = document.createElement('div');
                    description.className = 'preset-description';
                    description.textContent = preset.description;
                    description.style.color = 'var(--text-secondary)';
                    description.style.fontSize = '12px';
                    description.style.textAlign = 'center';

                    presetOption.appendChild(preview);
                    presetOption.appendChild(name);
                    presetOption.appendChild(description);

                    // Add hover and active states
                    presetOption.addEventListener('mouseover', () => {
                        if (!presetOption.classList.contains('active')) {
                            presetOption.style.background = 'var(--bg-active)';
                            presetOption.style.transform = 'translateY(-2px)';
                        }
                    });

                    presetOption.addEventListener('mouseout', () => {
                        if (!presetOption.classList.contains('active')) {
                            presetOption.style.background = 'var(--bg-hover)';
                            presetOption.style.transform = 'none';
                        }
                    });

                    // Add click handler
                    presetOption.addEventListener('click', () => {
                        presetSelector.querySelectorAll('.preset-option').forEach(opt => {
                            opt.classList.remove('active');
                            opt.style.background = 'var(--bg-hover)';
                            opt.style.borderColor = 'transparent';
                            opt.style.transform = 'none';
                        });

                        presetOption.classList.add('active');
                        presetOption.style.background = 'var(--bg-active)';
                        presetOption.style.borderColor = preset.accent;
                        presetOption.style.transform = 'translateY(-2px)';

                        settings.preset = preset.id;
                        settings.customAccentColor = preset.accent;
                        GM_setValue('ytTimestampSettings', settings);

                        // Apply preset configuration
                        applyPreset(preset.id);

                        showNotification(`Applied ${preset.name} preset`, preset.icon);
                    });

                    // Set initial active state
                    if (settings.preset === preset.id) {
                        presetOption.classList.add('active');
                        presetOption.style.background = 'var(--bg-active)';
                        presetOption.style.borderColor = preset.accent;
                    }

                    presetSelector.appendChild(presetOption);
                });

                control.appendChild(presetSelector);
                control.style.width = '100%';
                break;

            case 'size-selector':
                const sizeSelector = document.createElement('div');
                sizeSelector.className = 'size-selector';

                const sizes = [
                    { value: 'small', label: 'Compact', description: 'Space-saving size' },
                    { value: 'medium', label: 'Standard', description: 'Balanced visibility' },
                    { value: 'large', label: 'Spacious', description: 'Enhanced readability' }
                ];

                sizes.forEach(size => {
                    const sizeOption = document.createElement('div');
                    sizeOption.className = `size-option ${size.value} ${settings.notificationSize === size.value ? 'active' : ''}`;

                    // Create preview
                    const preview = document.createElement('div');
                    preview.className = 'size-preview';

                    const previewIcon = document.createElement('span');
                    previewIcon.className = 'size-preview-icon';
                    previewIcon.textContent = '📍';

                    const previewText = document.createElement('span');
                    previewText.className = 'size-preview-text';
                    previewText.textContent = 'Notification';

                    preview.appendChild(previewIcon);
                    preview.appendChild(previewText);

                    // Create label
                    const label = document.createElement('div');
                    label.className = 'size-label';
                    label.textContent = size.label;

                    // Create description
                    const description = document.createElement('div');
                    description.className = 'size-description';
                    description.textContent = size.description;

                    sizeOption.appendChild(preview);
                    sizeOption.appendChild(label);
                    sizeOption.appendChild(description);

                    // Add click handler
                    sizeOption.addEventListener('click', () => {
                        sizeSelector.querySelectorAll('.size-option').forEach(opt => {
                            opt.classList.remove('active');
                        });

                        sizeOption.classList.add('active');
                        settings.notificationSize = size.value;
                        GM_setValue('ytTimestampSettings', settings);

                        // Update UI immediately
                        updateNotificationSettings();

                        // Show preview with the new size
                        showNotification(`Size updated to ${size.label}`, '📏');
                    });

                    sizeSelector.appendChild(sizeOption);
                });

                control.appendChild(sizeSelector);
                control.style.width = '100%';
                break;

            case 'theme-selector':
                const themeSelector = document.createElement('div');
                themeSelector.className = 'theme-selector';
                themeSelector.style.display = 'grid';
                themeSelector.style.gridTemplateColumns = 'repeat(3, 1fr)';
                themeSelector.style.gap = 'var(--spacing-md)';
                themeSelector.style.width = '100%';

                const themes = [
                    {
                        value: 'dark',
                        label: 'Dark',
                        description: 'Dark interface',
                        icon: '🌙',
                        preview: {
                            background: '#1a1a1a',
                            text: '#ffffff',
                            accent: 'rgba(255, 255, 255, 0.1)'
                        }
                    },
                    {
                        value: 'light',
                        label: 'Light',
                        description: 'Light interface',
                        icon: '☀️',
                        preview: {
                            background: '#ffffff',
                            text: '#000000',
                            accent: 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    {
                        value: 'system',
                        label: 'System',
                        description: 'Follow your device',
                        icon: '🖥️',
                        preview: {
                            background: 'linear-gradient(to right, #1a1a1a 50%, #ffffff 50%)',
                            text: 'inherit',
                            accent: 'transparent'
                        }
                    }
                ];

                themes.forEach(theme => {
                    const themeOption = document.createElement('div');
                    themeOption.className = `theme-option ${theme.value}`;
                    themeOption.style.padding = 'var(--spacing-md)';
                    themeOption.style.borderRadius = 'var(--border-radius-md)';
                    themeOption.style.background = 'var(--bg-hover)';
                    themeOption.style.cursor = 'pointer';
                    themeOption.style.transition = 'var(--transition-smooth)';
                    themeOption.style.border = '2px solid transparent';
                    themeOption.style.display = 'flex';
                    themeOption.style.flexDirection = 'column';
                    themeOption.style.alignItems = 'center';
                    themeOption.style.gap = 'var(--spacing-sm)';

                    // Create preview
                    const preview = document.createElement('div');
                    preview.className = 'theme-preview';
                    preview.style.width = '100%';
                    preview.style.height = '80px';
                    preview.style.borderRadius = 'var(--border-radius-sm)';
                    preview.style.background = theme.preview.background;
                    preview.style.position = 'relative';
                    preview.style.overflow = 'hidden';
                    preview.style.border = '1px solid var(--border-color)';
                    preview.style.marginBottom = 'var(--spacing-sm)';

                    // Add preview content
                    if (theme.value !== 'system') {
                        // Create a mock notification for preview
                        const mockNotification = document.createElement('div');
                        mockNotification.style.position = 'absolute';
                        mockNotification.style.top = '50%';
                        mockNotification.style.left = '50%';
                        mockNotification.style.transform = 'translate(-50%, -50%)';
                        mockNotification.style.background = theme.preview.accent;
                        mockNotification.style.padding = '8px 12px';
                        mockNotification.style.borderRadius = '4px';
                        mockNotification.style.color = theme.preview.text;
                        mockNotification.style.fontSize = '12px';
                        mockNotification.style.display = 'flex';
                        mockNotification.style.alignItems = 'center';
                        mockNotification.style.gap = '6px';
                        
                        const mockEmoji = document.createElement('span');
                        mockEmoji.textContent = theme.icon;
                        mockEmoji.style.fontSize = '14px';
                        
                        const mockText = document.createElement('span');
                        mockText.textContent = theme.label;
                        
                        mockNotification.appendChild(mockEmoji);
                        mockNotification.appendChild(mockText);
                        preview.appendChild(mockNotification);
                    } else {
                        // Split preview for system theme
                        const darkSide = document.createElement('div');
                        darkSide.style.position = 'absolute';
                        darkSide.style.left = '0';
                        darkSide.style.top = '0';
                        darkSide.style.width = '50%';
                        darkSide.style.height = '100%';
                        darkSide.style.background = '#1a1a1a';
                        darkSide.style.display = 'flex';
                        darkSide.style.alignItems = 'center';
                        darkSide.style.justifyContent = 'center';
                        darkSide.style.color = '#ffffff';
                        darkSide.textContent = '🌙';
                        
                        const lightSide = document.createElement('div');
                        lightSide.style.position = 'absolute';
                        lightSide.style.right = '0';
                        lightSide.style.top = '0';
                        lightSide.style.width = '50%';
                        lightSide.style.height = '100%';
                        lightSide.style.background = '#ffffff';
                        lightSide.style.display = 'flex';
                        lightSide.style.alignItems = 'center';
                        lightSide.style.justifyContent = 'center';
                        lightSide.style.color = '#000000';
                        lightSide.textContent = '☀️';
                        
                        preview.appendChild(darkSide);
                        preview.appendChild(lightSide);
                    }

                    // Create label
                    const label = document.createElement('div');
                    label.className = 'theme-label';
                    label.textContent = theme.label;
                    label.style.fontWeight = '500';
                    label.style.color = 'var(--text-primary)';
                    label.style.fontSize = '14px';

                    // Create description
                    const description = document.createElement('div');
                    description.className = 'theme-description';
                    description.textContent = theme.description;
                    description.style.color = 'var(--text-secondary)';
                    description.style.fontSize = '12px';
                    description.style.textAlign = 'center';

                    themeOption.appendChild(preview);
                    themeOption.appendChild(label);
                    themeOption.appendChild(description);

                    // Add hover and active states
                    themeOption.addEventListener('mouseover', () => {
                        if (!themeOption.classList.contains('active')) {
                            themeOption.style.background = 'var(--bg-active)';
                            themeOption.style.transform = 'translateY(-2px)';
                        }
                    });
                    
                    themeOption.addEventListener('mouseout', () => {
                        if (!themeOption.classList.contains('active')) {
                            themeOption.style.background = 'var(--bg-hover)';
                            themeOption.style.transform = 'none';
                        }
                    });

                    // Add click handler
                    themeOption.addEventListener('click', () => {
                        themeSelector.querySelectorAll('.theme-option').forEach(opt => {
                            opt.classList.remove('active');
                            opt.style.background = 'var(--bg-hover)';
                            opt.style.borderColor = 'transparent';
                            opt.style.transform = 'none';
                        });

                        themeOption.classList.add('active');
                        themeOption.style.background = 'var(--bg-active)';
                        themeOption.style.borderColor = 'var(--primary-color)';
                        themeOption.style.transform = 'translateY(-2px)';
                        
                        settings.themeMode = theme.value;
                        GM_setValue('ytTimestampSettings', settings);

                        // Update UI immediately
                        updateThemeVariables();

                        showNotification(`Theme set to ${theme.label}`, theme.icon);
                    });
                    
                    // Set initial active state
                    if (settings.themeMode === theme.value) {
                        themeOption.classList.add('active');
                        themeOption.style.background = 'var(--bg-active)';
                        themeOption.style.borderColor = 'var(--primary-color)';
                    }

                    themeSelector.appendChild(themeOption);
                });

                control.appendChild(themeSelector);
                control.style.width = '100%';
                break;

            case 'preset-selector':
                const presetSelectorContainer = document.createElement('div');
                presetSelectorContainer.className = 'browser-presets';
                presetSelectorContainer.style.display = 'grid';
                presetSelectorContainer.style.gridTemplateColumns = 'repeat(3, 1fr)';
                presetSelectorContainer.style.gap = 'var(--spacing-md)';
                presetSelectorContainer.style.width = '100%';

                // Define the browser presets
                const presetOptions = [
                    {
                        id: 'custom',
                        name: 'Custom',
                        icon: '🛠️',
                        description: 'Keep your current settings'
                    },
                    {
                        id: 'chrome',
                        name: 'Chrome',
                        icon: '🌐',
                        description: 'Chrome-styled with blue accent'
                    },
                    {
                        id: 'firefox',
                        name: 'Firefox',
                        icon: '🦊',
                        description: 'Firefox-styled with orange accent'
                    }
                ];

                presetOptions.forEach(preset => {
                    const presetElement = document.createElement('div');
                    presetElement.className = `browser-preset ${settings.preset === preset.id ? 'active' : ''}`;
                    presetElement.dataset.preset = preset.id;
                    presetElement.style.padding = 'var(--spacing-md)';
                    presetElement.style.borderRadius = 'var(--border-radius-md)';
                    presetElement.style.background = 'var(--bg-hover)';
                    presetElement.style.cursor = 'pointer';
                    presetElement.style.textAlign = 'center';
                    presetElement.style.transition = 'var(--transition-smooth)';
                    presetElement.style.border = '2px solid transparent';

                    if (settings.preset === preset.id) {
                        presetElement.style.borderColor = 'var(--primary-color)';
                        presetElement.style.background = 'var(--bg-active)';
                    }

                    const iconElement = document.createElement('div');
                    iconElement.className = 'browser-icon';
                    iconElement.textContent = preset.icon;
                    iconElement.style.fontSize = '24px';
                    iconElement.style.marginBottom = 'var(--spacing-sm)';

                    const nameElement = document.createElement('div');
                    nameElement.className = 'browser-name';
                    nameElement.textContent = preset.name;
                    nameElement.style.fontWeight = 'bold';
                    nameElement.style.marginBottom = '4px';

                    const descElement = document.createElement('div');
                    descElement.className = 'browser-description';
                    descElement.textContent = preset.description;
                    descElement.style.color = 'var(--text-secondary)';
                    descElement.style.fontSize = '12px';

                    presetElement.appendChild(iconElement);
                    presetElement.appendChild(nameElement);
                    presetElement.appendChild(descElement);

                    presetElement.addEventListener('click', () => {
                        presetSelectorContainer.querySelectorAll('.browser-preset').forEach(p => {
                            p.classList.remove('active');
                            p.style.borderColor = 'transparent';
                            p.style.background = 'var(--bg-hover)';
                        });

                        presetElement.classList.add('active');
                        presetElement.style.borderColor = 'var(--primary-color)';
                        presetElement.style.background = 'var(--bg-active)';

                        // Apply the preset
                        applyPreset(preset.id);

                        // Show notification
                        showNotification(`Applied ${preset.name} preset`, preset.icon);
                    });

                    presetSelectorContainer.appendChild(presetElement);
                });

                control.appendChild(presetSelectorContainer);
                break;

            case 'number-input':
                const container = document.createElement('div');
                container.className = 'advanced-input-container';
                
                // For maxStoredTimestamps, create a visual slider
                if (id === 'maxStoredTimestamps') {
                    const rangeContainer = document.createElement('div');
                    rangeContainer.style.display = 'flex';
                    rangeContainer.style.alignItems = 'center';
                    rangeContainer.style.gap = 'var(--spacing-md)';
                    rangeContainer.style.width = '100%';

                    const range = document.createElement('input');
                    range.type = 'range';
                    range.id = id;
                    range.className = 'modern-input';
                    range.min = '10';
                    range.max = '500';
                    range.step = '10';
                    range.value = settings[id] || 100;

                    const valueContainer = document.createElement('div');
                    valueContainer.style.minWidth = '80px';
                    valueContainer.style.textAlign = 'center';
                    valueContainer.style.padding = 'var(--spacing-sm)';
                    valueContainer.style.background = 'var(--bg-hover)';
                    valueContainer.style.borderRadius = 'var(--border-radius-sm)';
                    valueContainer.style.fontWeight = 'bold';

                    const value = document.createElement('span');
                    value.textContent = range.value;
                    valueContainer.appendChild(value);

                    range.oninput = () => {
                        value.textContent = range.value;
                        
                        // Instantly apply changes
                        settings[id] = parseInt(range.value);
                        GM_setValue('ytTimestampSettings', settings);
                    };

                    rangeContainer.appendChild(range);
                    rangeContainer.appendChild(valueContainer);
                    control.appendChild(rangeContainer);
                } else {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.id = id;
                    input.value = settings[id] || '';
                    input.className = 'modern-input';
                    
                    input.addEventListener('change', () => {
                        settings[id] = parseInt(input.value);
                        GM_setValue('ytTimestampSettings', settings);
                    });
                    
                    container.appendChild(input);
                    control.appendChild(container);
                }
                break;

            case 'sync-selector':
                const syncSelector = document.createElement('div');
                syncSelector.className = 'sync-selector';
                syncSelector.style.display = 'grid';
                syncSelector.style.gridTemplateColumns = 'repeat(3, 1fr)';
                syncSelector.style.gap = 'var(--spacing-md)';
                syncSelector.style.width = '100%';
                
                const syncOptions = [
                    {
                        value: 'newest',
                        label: 'Keep Newest',
                        description: 'Always use the most recent timestamp',
                        icon: '🔄',
                        color: '#4CAF50'
                    },
                    {
                        value: 'manual',
                        label: 'Manual Choice',
                        description: 'Choose which timestamp to keep',
                        icon: '👆',
                        color: '#2196F3'
                    },
                    {
                        value: 'merge',
                        label: 'Smart Merge',
                        description: 'Intelligently combine timestamps',
                        icon: '🔀',
                        color: '#9C27B0'
                    }
                ];
                
                syncOptions.forEach(option => {
                    const syncOption = document.createElement('div');
                    syncOption.className = `sync-option ${settings.syncBehavior === option.value ? 'active' : ''}`;
                    syncOption.style.padding = 'var(--spacing-md)';
                    syncOption.style.borderRadius = 'var(--border-radius-md)';
                    syncOption.style.background = 'var(--bg-hover)';
                    syncOption.style.cursor = 'pointer';
                    syncOption.style.transition = 'var(--transition-smooth)';
                    syncOption.style.border = '2px solid transparent';
                    syncOption.style.display = 'flex';
                    syncOption.style.flexDirection = 'column';
                    syncOption.style.alignItems = 'center';
                    syncOption.style.gap = 'var(--spacing-sm)';
                    
                    // Create preview container
                    const preview = document.createElement('div');
                    preview.className = 'sync-preview';
                    preview.style.width = '100%';
                    preview.style.height = '80px';
                    preview.style.borderRadius = 'var(--border-radius-sm)';
                    preview.style.background = 'var(--bg-secondary)';
                    preview.style.border = '1px solid var(--border-color)';
                    preview.style.display = 'flex';
                    preview.style.alignItems = 'center';
                    preview.style.justifyContent = 'center';
                    preview.style.position = 'relative';
                    preview.style.overflow = 'hidden';
                    preview.style.marginBottom = 'var(--spacing-sm)';

                    // Create icon container
                    const iconContainer = document.createElement('div');
                    iconContainer.style.width = '40px';
                    iconContainer.style.height = '40px';
                    iconContainer.style.borderRadius = '50%';
                    iconContainer.style.background = option.color;
                    iconContainer.style.display = 'flex';
                    iconContainer.style.alignItems = 'center';
                    iconContainer.style.justifyContent = 'center';
                    iconContainer.style.fontSize = '24px';
                    iconContainer.style.color = '#ffffff';
                    iconContainer.style.boxShadow = '0 2px 8px ' + option.color + '80';
                    iconContainer.textContent = option.icon;

                    // Create visual representation
                    const visualEffect = document.createElement('div');
                    visualEffect.style.position = 'absolute';
                    visualEffect.style.bottom = '0';
                    visualEffect.style.left = '0';
                    visualEffect.style.width = '100%';
                    visualEffect.style.height = '4px';
                    visualEffect.style.background = option.color;
                    visualEffect.style.opacity = '0.8';

                    preview.appendChild(iconContainer);
                    preview.appendChild(visualEffect);
                    
                    // Create label
                    const label = document.createElement('div');
                    label.className = 'sync-label';
                    label.textContent = option.label;
                    label.style.fontWeight = '500';
                    label.style.color = 'var(--text-primary)';
                    label.style.fontSize = '14px';
                    
                    // Create description
                    const description = document.createElement('div');
                    description.className = 'sync-description';
                    description.textContent = option.description;
                    description.style.color = 'var(--text-secondary)';
                    description.style.fontSize = '12px';
                    description.style.textAlign = 'center';

                    syncOption.appendChild(preview);
                    syncOption.appendChild(label);
                    syncOption.appendChild(description);

                    // Add hover and active states
                    syncOption.addEventListener('mouseover', () => {
                        if (!syncOption.classList.contains('active')) {
                            syncOption.style.background = 'var(--bg-active)';
                            syncOption.style.transform = 'translateY(-2px)';
                        }
                    });

                    syncOption.addEventListener('mouseout', () => {
                        if (!syncOption.classList.contains('active')) {
                            syncOption.style.background = 'var(--bg-hover)';
                            syncOption.style.transform = 'none';
                        }
                    });

                    // Add click handler
                    syncOption.addEventListener('click', () => {
                        syncSelector.querySelectorAll('.sync-option').forEach(opt => {
                            opt.classList.remove('active');
                            opt.style.background = 'var(--bg-hover)';
                            opt.style.borderColor = 'transparent';
                            opt.style.transform = 'none';
                        });
                        
                        syncOption.classList.add('active');
                        syncOption.style.background = 'var(--bg-active)';
                        syncOption.style.borderColor = option.color;
                        syncOption.style.transform = 'translateY(-2px)';
                        
                        settings.syncBehavior = option.value;
                        GM_setValue('ytTimestampSettings', settings);
                        
                        showNotification(`Sync mode set to ${option.label}`, option.icon);
                    });

                    // Set initial active state
                    if (settings.syncBehavior === option.value) {
                        syncOption.classList.add('active');
                        syncOption.style.background = 'var(--bg-active)';
                        syncOption.style.borderColor = option.color;
                    }
                    
                    syncSelector.appendChild(syncOption);
                });
                
                control.appendChild(syncSelector);
                control.style.width = '100%';
                break;
        }

        header.appendChild(control);
        option.appendChild(header);

        return option;
    };

    // Apply preset configuration
    const applyPreset = (presetName) => {
        try {
            const presets = {
                chrome: {
                    saveHotkey: 'CTRL+S',
                    restoreHotkey: 'CTRL+R',
                    settingsHotkey: 'CTRL+SHIFT+S',
                    customAccentColor: '#4285F4', // Chrome blue
                    notificationPosition: {
                        duringPlayback: {
                            position: 'top-right',
                            margin: 120
                        },
                        onHomepage: {
                            position: 'bottom-right',
                            margin: 120
                        }
                    },
                    themeMode: 'dark',
                    blurAmount: 24
                },
                firefox: {
                    saveHotkey: 'CTRL+S',
                    restoreHotkey: 'CTRL+R',
                    settingsHotkey: 'CTRL+SHIFT+S',
                    customAccentColor: '#FF9500', // Firefox orange
                    notificationPosition: {
                        duringPlayback: {
                            position: 'top-right',
                            margin: 120
                        },
                        onHomepage: {
                            position: 'bottom-right',
                            margin: 120
                        }
                    },
                    themeMode: 'dark',
                    blurAmount: 24
                },
                custom: { } // No changes, use current settings
            };

            if (presetName !== 'custom' && presets[presetName]) {
                // Deep merge settings to preserve nested structures
                const newSettings = {
                    ...settings,
                    ...presets[presetName],
                    notificationPosition: {
                        duringPlayback: {
                            ...settings.notificationPosition.duringPlayback,
                            ...presets[presetName].notificationPosition?.duringPlayback
                        },
                        onHomepage: {
                            ...settings.notificationPosition.onHomepage,
                            ...presets[presetName].notificationPosition?.onHomepage
                        }
                    }
                };
                
                // Update settings
                Object.assign(settings, newSettings);
                settings.preset = presetName;

                // Save to storage
                GM_setValue('ytTimestampSettings', settings);

                // Update the UI to reflect new settings
                updateThemeVariables();

                // Refresh the settings UI
                const settingsUI = document.querySelector('.yt-timestamp-settings');
                if (settingsUI) {
                    settingsUI.remove();
                    createSettingsUI().classList.add('show');
                }

                showNotification(`Applied ${presetName} preset!`, '✨');
            }
        } catch (error) {
            console.error('Error applying preset:', error);
            showNotification('Error applying preset!', '❌');
        }
    };

    const createQuickControls = () => {
        // Remove existing controls if any
        const existingControls = document.querySelector('.timestamp-controls');
        if (existingControls) {
            existingControls.remove();
        }

        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'timestamp-controls';
        controlsContainer.style.cssText = `
            position: absolute;
            left: 10px;
            bottom: 10px;
            z-index: 9999;
            display: ${settings.showQuickControls ? 'flex' : 'none'};
            gap: 10px;
            transition: opacity 0.3s ease;
            opacity: 1;
        `;

        // Add mouseout event to hide controls
        const playerElement = document.querySelector('.html5-video-container');
        if (playerElement) {
            playerElement.addEventListener('mouseenter', () => {
                controlsContainer.style.opacity = '1';
                controlsContainer.style.pointerEvents = 'auto';
            });

            playerElement.addEventListener('mouseleave', () => {
                controlsContainer.style.opacity = '0';
                controlsContainer.style.pointerEvents = 'none';
            });
        }

        // Create buttons using DOM methods instead of innerHTML
        const createButton = (emoji, text, title, clickHandler) => {
            const button = document.createElement('button');
            button.className = 'timestamp-button';
            button.title = title;

            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'emoji';
            emojiSpan.textContent = emoji;

            button.appendChild(emojiSpan);
            button.appendChild(document.createTextNode(' ' + text));

            button.addEventListener('click', clickHandler);
            return button;
        };

        // Save button
        const saveButton = createButton('💾', 'Save Position', 'Save current video position', () => {
            const video = document.querySelector('video');
            const videoId = getVideoId();
            if (video && videoId) {
                saveTimestamp(videoId, video.currentTime, true);
            }
        });

        // Restore button
        const restoreButton = createButton('⏮️', 'Restore', 'Jump to last saved position', () => {
            const video = document.querySelector('video');
            const videoId = getVideoId();
            if (video && videoId) {
                const savedData = loadTimestamp(videoId);
                if (savedData) {
                    video.currentTime = savedData.time;
                    showNotification(`Jumped back to ${formatTime(savedData.time)}`, '⏮️');
                } else {
                    showNotification('No saved position found', '🔍');
                }
            }
        });

        // Clear button
        const clearButton = createButton('🗑️', 'Clear Saved', 'Clear saved position for this video', () => {
            const videoId = getVideoId();
            if (videoId) {
                const timestamps = GM_getValue('timestamps', {});
                delete timestamps[videoId];
                GM_setValue('timestamps', timestamps);
                showNotification('Timestamp cleared! 🧹', '✨');
            }
        });

        controlsContainer.appendChild(saveButton);
        controlsContainer.appendChild(restoreButton);
        controlsContainer.appendChild(clearButton);

        const playerControls = document.querySelector('.ytp-right-controls');
        if (playerControls) {
            playerControls.parentElement.insertBefore(controlsContainer, playerControls);
        }
    };

    const createSettingsUI = () => {
        try {
            // Check if settings UI already exists
            let settingsDiv = document.querySelector('.yt-timestamp-settings');
            if (settingsDiv) {
                return settingsDiv;
            }

            settingsDiv = document.createElement('div');

            // Determine theme based on themeMode setting
            let useDarkMode = true;
            if (settings.themeMode === 'light') {
                useDarkMode = false;
            } else if (settings.themeMode === 'system') {
                useDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            }

            settingsDiv.className = `yt-timestamp-settings ${useDarkMode ? '' : 'light'}`;

            // Create header with tabs
            const header = document.createElement('div');
            header.className = 'settings-header';

            // Add title with logo
            const titleDiv = document.createElement('div');
            titleDiv.className = 'settings-title';

            const title = document.createElement('h2');

            // Add icon and text separately
            const titleEmoji = document.createElement('span');
            titleEmoji.textContent = '⏱️';
            title.appendChild(titleEmoji);
            title.appendChild(document.createTextNode(' YouTube Timestamp Saver'));

            titleDiv.appendChild(title);

            const closeBtn = document.createElement('span');
            closeBtn.className = 'settings-close';
            closeBtn.textContent = '×';
            titleDiv.appendChild(closeBtn);

            header.appendChild(titleDiv);

            // Create tabs
            const tabs = [
                { id: 'general', icon: '⚙️', label: 'General' },
                { id: 'appearance', icon: '🎨', label: 'Appearance' },
                { id: 'timestamps', icon: '⏱️', label: 'Timestamps' },
                { id: 'notifications', icon: '🔔', label: 'Notifications' },
                { id: 'hotkeys', icon: '⌨️', label: 'Hotkeys' },
                { id: 'advanced', icon: '🛠️', label: 'Advanced' }
            ];

            const tabsContainer = document.createElement('div');
            tabsContainer.className = 'settings-tabs';

            tabs.forEach(tab => {
                const tabButton = document.createElement('button');
                tabButton.className = `settings-tab ${tab.id === 'general' ? 'active' : ''}`;

                const tabIcon = document.createElement('span');
                tabIcon.className = 'tab-icon';
                tabIcon.textContent = tab.icon;
                tabIcon.style.marginRight = '2px'; // Reduce space between icon and text

                tabButton.appendChild(tabIcon);
                tabButton.appendChild(document.createTextNode(tab.label));

                tabButton.dataset.tab = tab.id;
                tabsContainer.appendChild(tabButton);
            });

            header.appendChild(tabsContainer);

            // Add CSS to fix tab layout and prevent scrolling issues
            const styleFixForTabs = document.createElement('style');
            styleFixForTabs.textContent = `
                .yt-timestamp-settings .settings-tabs {
                    display: flex;
                    flex-wrap: nowrap;
                    justify-content: space-between;
                    width: 100%;
                    padding: 8px 0;
                    overflow-x: visible;
                    margin-bottom: 10px;
                }
                
                .yt-timestamp-settings .settings-tab {
                    flex: 1; /* Even distribution of space */
                    min-width: 100px; /* Increased minimum width for content */
                    margin: 0 1px; /* Reduced spacing between tabs */
                    padding: 12px 12px; /* More horizontal padding to avoid text cramping */
                    font-size: 14px;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                    overflow: hidden;
                    border-radius: 4px;
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                    background: rgba(0,0,0,0.03);
                    text-align: center; /* Center text in tabs */
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-primary, rgba(0, 0, 0, 0.9));
                }
                
                /* Tab-specific styling to ensure proper display */
                .yt-timestamp-settings .settings-tab[data-tab="notifications"] {
                    flex: 1.3; /* Give this tab even more space */
                }
                
                .yt-timestamp-settings .settings-tab[data-tab="timestamps"] {
                    flex: 1.2; /* Give this tab more space */
                }
                
                .yt-timestamp-settings .settings-tab[data-tab="advanced"] {
                    flex: 1.1; /* Give this tab more space */
                }
                
                .yt-timestamp-settings .settings-tab:hover {
                    background: rgba(0,0,0,0.05);
                }
                
                .yt-timestamp-settings .settings-tab.active {
                    background: transparent;
                    border-color: var(--custom-accent, #3ea6ff);
                    color: var(--custom-accent, #3ea6ff);
                    font-weight: 500;
                }
                
                .yt-timestamp-settings .settings-tab .tab-icon {
                    margin-right: 4px;
                    display: inline-flex;
                    align-items: center;
                }
                
                .yt-timestamp-settings .settings-content {
                    max-height: 70vh;
                    overflow-y: auto;
                    padding-right: 10px;
                }
                
                .yt-timestamp-settings .settings-page {
                    padding: 15px 10px;
                }
                
                .yt-timestamp-settings {
                    min-width: 750px;
                    max-width: 95vw;
                    width: 780px;
                    background: var(--bg-primary, #fff);
                    color: var(--text-primary, #0f0f0f);
                    border-radius: 8px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                }
                
                /* Match modern switch design */
                .yt-timestamp-settings .modern-slider {
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                
                /* Advanced settings enhancements */
                .yt-timestamp-settings .advanced-input-container {
                    width: 100%;
                    padding: 5px 0;
                }
                
                .yt-timestamp-settings .advanced-slider {
                    -webkit-appearance: none;
                    width: 100%;
                    height: 6px;
                    border-radius: 3px;
                    background: var(--slider-bg, rgba(0,0,0,0.1));
                    outline: none;
                    margin: 20px 0 8px 0;
                }
                
                .yt-timestamp-settings .advanced-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    background: var(--custom-accent, #3ea6ff);
                    cursor: pointer;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                    transition: all 0.2s ease;
                }
                
                .yt-timestamp-settings .advanced-slider::-webkit-slider-thumb:hover {
                    transform: scale(1.15);
                    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                }
                
                .yt-timestamp-settings .current-value {
                    display: inline-block;
                    font-weight: 500;
                    font-size: 15px;
                    margin-left: 12px;
                    color: var(--custom-accent, #3ea6ff);
                    min-width: 40px;
                    padding: 3px 8px;
                    border-radius: 4px;
                    background: var(--bg-secondary, rgba(0,0,0,0.05));
                    text-align: center;
                    border: 1px solid var(--border-light, rgba(0,0,0,0.08));
                    cursor: pointer;
                }
                
                /* Sync cards styling */
                .yt-timestamp-settings .sync-option-cards {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    margin: 15px 0 5px 0;
                    width: 100%;
                }
                
                .yt-timestamp-settings .sync-header {
                    font-size: 13px;
                    color: var(--text-secondary, rgba(0,0,0,0.6));
                    margin-bottom: 8px;
                    padding-left: 2px;
                }
                
                .yt-timestamp-settings .sync-cards-wrapper {
                    display: flex;
                    gap: 10px;
                    width: 100%;
                }
                
                .yt-timestamp-settings .sync-card {
                    flex: 1;
                    border-radius: 6px;
                    padding: 12px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    display: flex;
                    align-items: flex-start;
                    text-align: left;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
                    border: 1px solid var(--border-color, rgba(0,0,0,0.1));
                }
                
                .yt-timestamp-settings .sync-card.active {
                    background: var(--custom-accent, #3ea6ff);
                    color: white;
                    border-color: var(--custom-accent, #3ea6ff);
                }
                
                .yt-timestamp-settings .sync-card:not(.active) {
                    background: var(--bg-secondary, rgba(0,0,0,0.02));
                }
                
                .yt-timestamp-settings .sync-card:hover:not(.active) {
                    transform: translateY(-2px);
                    box-shadow: 0 3px 8px rgba(0,0,0,0.12);
                    border-color: var(--border-hover, rgba(0,0,0,0.2));
                }
                
                .yt-timestamp-settings .sync-icon-wrapper {
                    margin-right: 10px;
                    width: 36px;
                    height: 36px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: rgba(255,255,255,0.85);
                    border-radius: 50%;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                }
                
                .yt-timestamp-settings .sync-card.active .sync-icon-wrapper {
                    background: rgba(255,255,255,0.25);
                    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
                }
                
                .yt-timestamp-settings .sync-content {
                    flex: 1;
                }
                
                .yt-timestamp-settings .sync-icon {
                    font-size: 20px;
                }
                
                .yt-timestamp-settings .sync-label {
                    font-weight: 600;
                    margin-bottom: 4px;
                    font-size: 14px;
                }
                
                .yt-timestamp-settings .sync-description {
                    font-size: 12px;
                    opacity: 0.85;
                    line-height: 1.3;
                }
                
                @media (max-width: 768px) {
                    .yt-timestamp-settings {
                        min-width: 700px;
                        width: 95vw;
                    }
                    
                    .yt-timestamp-settings .settings-tab {
                        padding: 8px 6px;
                        font-size: 13px;
                        min-width: 90px;
                        margin: 0 1px;
                    }
                    
                    .yt-timestamp-settings .sync-option-cards {
                        flex-direction: column;
                    }
                }
                
                @media (max-width: 650px) {
                    .yt-timestamp-settings {
                        min-width: 520px;
                    }
                    
                    .yt-timestamp-settings .settings-tab {
                        padding: 6px 4px;
                        font-size: 12px;
                        min-width: 70px;
                    }
                }
            `;
            settingsDiv.appendChild(styleFixForTabs);

            // Create content area
            const content = document.createElement('div');
            content.className = 'settings-content';

            // Settings categories and options
            const settingCategories = {
                general: [
                    createSettingOption('autoSave', 'Automatic Position Saving', 'Automatically save your position while watching videos'),
                    createSettingOption('autoResume', 'Resume from Last Position', 'Automatically resume videos from where you left off'),
                    createSettingOption('saveOnPause', 'Save When Video is Paused', 'Save your position when the video is paused'),
                    createSettingOption('saveInterval', 'Save Frequency', 'How often to save your position (in seconds)', 'time-input'),
                    createSettingOption('minSaveInterval', 'Minimum Time Between Saves', 'Minimum time in seconds between automatic saves', 'time-input')
                ],
                appearance: [
                    createSettingOption('themeMode', 'Interface Theme', 'Choose between dark, light, or system theme', 'theme-selector'),
                    createSettingOption('customAccentColor', 'Highlight Color', 'Choose your preferred highlight color for the interface', 'color'),
                    createSettingOption('blurAmount', 'Background Blur', 'Adjust background blur intensity (0 = disabled)', 'time-input')
                ],
                timestamps: [
                    createSettingOption('timestampFormat', 'Timestamp Display Format', 'Format for displaying timestamps', 'format-selector'),
                    createSettingOption('smartTimestampHandling', 'Intelligent Timestamp Handling', 'Intelligently manage timestamp tracking and restoration'),
                    createSettingOption('removeTimestampFromURL', 'Remove Timestamp from URLs', 'Remove timestamp parameters from YouTube URLs after saving')
                ],
                notifications: [
                    createSettingOption('enableNotifications', 'Enable Notifications', 'Master switch for all notifications in the script'),
                    createSettingOption('restoreNotifications', 'Video Resume Notifications', 'Show welcome back message when resuming from a saved position'),
                    createSettingOption('notificationDuration', 'Notification Duration', 'How long notifications remain visible (in seconds)', 'time-input'),
                    createSettingOption('notificationPosition', 'Notification Position', 'Choose where notifications appear during video playback or on the YouTube homepage', 'position-picker'),
                    createSettingOption('notificationSize', 'Notification Size', 'Choose how large notifications appear', 'size-selector')
                ],
                hotkeys: [
                    createSettingOption('saveHotkey', 'Hotkey: Save Current Position', 'Hotkey for manually saving current position', 'hotkey'),
                    createSettingOption('restoreHotkey', 'Hotkey: Restore Saved Position', 'Hotkey for restoring to saved position', 'hotkey'),
                    createSettingOption('settingsHotkey', 'Hotkey: Open Settings Panel', 'Hotkey for opening settings', 'hotkey'),
                    createSettingOption('preset', 'Preset Settings for Browsers', 'Apply pre-defined settings packages', 'preset-selector')
                ],
                advanced: [
                    createSettingOption('maxStoredTimestamps', 'Maximum Timestamps Stored', 'Maximum number of timestamps to store (0 = unlimited)', 'number-input'),
                    createSettingOption('syncBehavior', 'Timestamp Conflict Resolution', 'How to handle conflicts in timestamp data', 'sync-selector'),
                    createSettingOption('debugMode', 'Enable Debugging', 'Show detailed debug information in the console')
                ]
            };

            // Create pages from categories
            Object.entries(settingCategories).forEach(([pageId, options]) => {
                const page = document.createElement('div');
                page.className = `settings-page`;
                page.id = `page-${pageId}`;
                page.style.display = pageId === 'general' ? 'block' : 'none';

                const section = document.createElement('div');
                section.className = 'settings-section';
                options.forEach(option => section.appendChild(option));

                page.appendChild(section);
                content.appendChild(page);
            });

            // Assemble the UI in the correct order
            settingsDiv.appendChild(header);
            settingsDiv.appendChild(content);

            // Add event listeners for tabs
            tabsContainer.addEventListener('click', (e) => {
                const target = e.target.closest('.settings-tab');
                if (target) {
                    // Remove active class and inline styles from all tabs
                    tabsContainer.querySelectorAll('.settings-tab').forEach(tab => {
                        tab.classList.remove('active');
                        tab.style.color = ''; // Reset to default
                        tab.style.borderColor = ''; // Reset to default
                    });
                    
                    // Add active class to clicked tab and apply accent color
                    target.classList.add('active');
                    target.style.color = settings.customAccentColor;
                    target.style.borderColor = settings.customAccentColor;

                    const tabId = target.dataset.tab;
                    content.querySelectorAll('.settings-page').forEach(page => {
                        page.style.display = 'none';
                    });
                    document.getElementById(`page-${tabId}`).style.display = 'block';
                }
            });

            // Add event listeners
            closeBtn.addEventListener('click', () => {
                settingsDiv.classList.remove('show');
            });

            document.body.appendChild(settingsDiv);
            return settingsDiv;
        }
        catch (error) {
            console.error('Error creating settings UI:', error);
        }
    };

    // Register settings menu command
    GM_registerMenuCommand('YouTube Timestamp Saver Settings', () => {
        const settingsDiv = createSettingsUI();
        settingsDiv.classList.add('show');
    });

    // Function to handle initial video load and restoration
    const initializeWithVideo = () => {
        debug('Running initial page load video check');
        
        // Use a longer timeout for initial page load
        setTimeout(() => {
            try {
            const videoId = getVideoId();
                const video = document.querySelector('video');

            if (video && videoId) {
                    debug(`Initial video detected: ${videoId}`);
                    currentVideoId = videoId;

                    const savedData = loadTimestamp(videoId);

                    if (savedData && settings.autoResume) {
                        const currentTime = video.currentTime;
                        // Use a wider threshold for initial load
                        if (Math.abs(currentTime - savedData.time) > 3) {
                            debug(`Initial load: Restoring to saved position: ${formatTime(savedData.time)}`);
                            video.currentTime = savedData.time;

                            // Force a notification for initial load with a generous delay
                            if (settings.restoreNotifications) {
                                debug('Showing initial load notification');
                                console.log('Showing initial welcome back notification');
                                
                                // Use a longer delay for the first load notification
                                setTimeout(() => {
                                    console.log(`Attempting to show notification for ${formatTime(savedData.time)}`);
                                    showNotification(`Welcome back! Resumed from ${formatTime(savedData.time)}`, '⏮️');
                                }, 3000);
                            }
                            } else {
                            debug(`Initial load: Current time (${formatTime(currentTime)}) is close to saved time (${formatTime(savedData.time)}), not restoring`);
                        }
                    }
            }
        } catch (error) {
                console.error('Error in initial video load handler:', error);
            }
        }, 2500); // Much longer delay for the initial page load to ensure player is ready
    };

    // Initialize theme variables before everything else
    updateThemeVariables();

    // Initialize system in a reliable sequence
    const initializeSystem = () => {
        try {
            debug('YouTube Timestamp Saver initializing');
            
            // Create a cleanup registry for graceful shutdown
            const cleanupRegistry = [];
            
            // Add theme container for better style encapsulation
            addThemeContainer();
            
            // Initialize theme based on YouTube's current theme
            const isYouTubeDark = document.documentElement.getAttribute('dark') === 'true';
            updateThemeVariables(isYouTubeDark);
            updateNotificationSettings(isYouTubeDark);
            
            // Run initial video check
            const initialCheck = () => {
                try {
                    const videoId = getVideoId();
                    if (!videoId) {
                        debug('No video detected during initialization');
                        return;
                    }
                    
                    const video = document.querySelector('video');
                    if (!video) {
                        debug('Video element not available yet, will try again');
                        // Set a slightly longer timeout for slower page loads
                        setTimeout(initialCheck, 1000);
                        return;
                    }
                    
                    debug(`Initial video detected: ${videoId}`);
                    currentVideoId = videoId;
                    
                    // Initialize for the first detected video
                    initializeWithVideo();
                    
        } catch (error) {
                    console.error('Error during initial video check:', error);
                }
            };
            
            // Run initial check now
            initialCheck();
            
            // Setup keyboard shortcuts
            setupKeyboardShortcuts();
            
            // Start intervals and store cleanup function
            const intervalCleanup = startIntervals();
            if (intervalCleanup && intervalCleanup.cleanup) {
                cleanupRegistry.push(intervalCleanup.cleanup);
            }
            
            // Setup mutation observer for navigation
            const observerCleanup = setupMutationObserver();
            if (observerCleanup && observerCleanup.cleanup) {
                cleanupRegistry.push(observerCleanup.cleanup);
            }
            
            // Setup player change detection
            const playerChangesCleanup = observePlayerChanges();
            if (playerChangesCleanup && playerChangesCleanup.cleanup) {
                cleanupRegistry.push(playerChangesCleanup.cleanup);
            }
            
            // Create settings UI if needed
            createSettingsUI();
            
            // Create quick controls
            createQuickControls();
            
            // Register cleanup for script shutdown or reload
            const performCleanup = () => {
                debug('Performing cleanup');
                cleanupRegistry.forEach(cleanup => {
                    try {
                        if (typeof cleanup === 'function') {
                            cleanup();
                        }
                    } catch (e) {
                        console.error('Error during cleanup:', e);
                    }
                });
            };
            
            // Add cleanup to window unload event
            window.addEventListener('beforeunload', performCleanup);
            
            debug('YouTube Timestamp Saver initialization complete');
            
            // Return cleanup function for potential script reloads
            return {
                cleanup: performCleanup
            };
            
        } catch (error) {
            console.error('Initialization error:', error);
        }
    };
    
    // Function to process video timestamp for a given video
    const processVideoTimestamp = (videoId, video, isInitialLoad = false) => {
        if (!videoId || !video) return;
        
        try {
                                const savedData = loadTimestamp(videoId);

            if (!savedData || !settings.autoResume) {
                debug(`No saved data or auto-resume disabled for ${videoId}`);
                return;
            }
            
                                    const currentTime = video.currentTime;
            // Use wider threshold for initial load
            const threshold = isInitialLoad ? 3 : 5;
            const isNearBeginning = currentTime < threshold;
            
            if (isNearBeginning && Math.abs(currentTime - savedData.time) > threshold) {
                debug(`${isInitialLoad ? 'Initial' : 'Normal'} load: Restoring to saved position: ${formatTime(savedData.time)}`);
                
                // Set the video position
                                        video.currentTime = savedData.time;

                // Show notification if enabled
                if (settings.restoreNotifications) {
                    debug(`Preparing to show restore notification for ${formatTime(savedData.time)}`);
                    
                    // Use appropriate delay based on context
                    const notificationDelay = isInitialLoad ? 3000 : 1500;
                    
                                        setTimeout(() => {
                        // Verify we're still on the same video
                        if (getVideoId() === videoId) {
                            showNotification(`Welcome back! Resumed from ${formatTime(savedData.time)}`, '⏮️')
                                .catch(error => {
                                    debug(`Notification error: ${error.message}`);
                                });
                        }
                    }, notificationDelay);
                }
                                    } else {
                debug(`Not restoring: Current time (${formatTime(currentTime)}) is close to saved time (${formatTime(savedData.time)})`);
            }
        } catch (error) {
            console.error(`Error processing timestamp for video ${videoId}:`, error);
        }
    };
    
    // Start the interval timers
    const startIntervals = () => {
        // Track interval states to prevent redundant operations
        let lastSaveAttemptTime = 0;
        const saveAttemptThrottle = 2000; // Only attempt saves every 2 seconds
        let checkIntervalId = null;
        let autoSaveIntervalId = null;
        let lastVideoCheckId = '';
        let videoCheckCount = 0;
        
        // Performance optimization: Cache DOM queries and video state
        let cachedVideo = null;
        let lastVideoTime = 0;
        let lastVideoPaused = true;
        
        // Schedule the next check based on activity level
        const scheduleNextCheck = () => {
            // Clear existing check interval if any
            if (checkIntervalId) clearInterval(checkIntervalId);
            
            // Determine check frequency based on activity
            const baseInterval = settings.checkInterval || 2000;
            const activeInterval = 
                videoCheckCount > 5 && lastVideoCheckId === currentVideoId ? 
                // Increase interval for stable videos (same video for a while)
                Math.min(baseInterval * 2, 5000) : 
                baseInterval;
                
            checkIntervalId = setInterval(checkCurrentVideo, activeInterval);
            debug(`Scheduled video checks every ${activeInterval}ms`);
        };
        
        // Main video check function - extracted for clarity and reuse
        const checkCurrentVideo = () => {
            try {
                const videoId = getVideoId();
                
                // Skip if no video is present
                if (!videoId) {
                    // Reset state if video disappeared
                    if (currentVideoId) {
                        debug('Video removed from page');
                        currentVideoId = null;
                        cachedVideo = null;
                    }
                    return;
                }
                
                // Cache video element to avoid repeated DOM queries
                if (!cachedVideo || !document.contains(cachedVideo)) {
                    cachedVideo = document.querySelector('video');
                }
                
                // Adjust check count for adaptive intervals
                if (videoId === lastVideoCheckId) {
                    videoCheckCount++;
                } else {
                    videoCheckCount = 0;
                    lastVideoCheckId = videoId;
                }
                
                if (videoId === currentVideoId) {
                    // Same video still playing - just check for save conditions
                    const now = Date.now();
                    
                    // Throttle checks to avoid excessive processing
                    if (now - lastSaveAttemptTime < saveAttemptThrottle) return;
                    lastSaveAttemptTime = now;
                    
                    // Only process meaningful state changes
                    if (cachedVideo) {
                        const currentTime = Math.floor(cachedVideo.currentTime);
                        const isPaused = cachedVideo.paused;
                        
                        // Only save if state changed meaningfully
                        const timeChanged = Math.abs(currentTime - lastVideoTime) >= 5;
                        const playStateChanged = isPaused !== lastVideoPaused;
                        
                        if ((timeChanged || playStateChanged) && 
                            !isPaused && currentTime > 0) {
                            // Only save if in the meaningful part of the video
                            if (currentTime > 30 && currentTime < cachedVideo.duration - 30) {
                                saveTimestamp(videoId, currentTime);
                            }
                        }
                        
                        // Update cached state
                        lastVideoTime = currentTime;
                        lastVideoPaused = isPaused;
                    }
                    return;
                }
                
                // New video detected
                debug(`New video detected: ${videoId} (previous: ${currentVideoId || 'none'})`);
                currentVideoId = videoId;
                videoCheckCount = 0;
                lastVideoCheckId = videoId;
                
                // Reset adaptive interval when video changes
                scheduleNextCheck();
                
                // Process video timestamp after a delay to ensure player is ready
                if (!cachedVideo) {
                    debug('Video element not found yet');
                    return;
                }
                
                setTimeout(() => {
                    processVideoTimestamp(videoId, cachedVideo, false);
                }, 1000);
                
            } catch (error) {
                console.error('Error in main interval handler:', error);
            }
        };
        
        // Auto-save implementation with shared video cache
        const performAutoSave = () => {
            try {
                if (!settings.autoSave) return;
                
                const now = Date.now();
                // Skip if minimum save interval hasn't elapsed
                if (now - lastSaveTime < settings.minSaveInterval * 1000) return;
                
                const videoId = currentVideoId || getVideoId();
                if (!videoId) return;
                
                // Reuse cached video element when possible
                if (!cachedVideo || !document.contains(cachedVideo)) {
                    cachedVideo = document.querySelector('video');
                }
                
                // Only save if video is actively playing
                if (cachedVideo && cachedVideo.currentTime > 0 && !cachedVideo.paused) {
                    const currentTime = cachedVideo.currentTime;
                    // Skip very beginning and end of videos
                    if (currentTime > 30 && currentTime < cachedVideo.duration - 30) {
                        saveTimestamp(videoId, currentTime, false);
                        lastSaveTime = now;
                    }
                }
            } catch (error) {
                console.error('Error in auto-save interval:', error);
            }
        };
        
        // Start main checks and schedule adaptive interval
        checkCurrentVideo();
        scheduleNextCheck();
        
        // Auto-save interval - keep at fixed interval but share cached data
        autoSaveIntervalId = setInterval(performAutoSave, 
            Math.max(settings.minSaveInterval * 1000, settings.saveInterval * 1000));
        
        // Return cleanup function for proper disposal
        return {
            cleanup: () => {
                if (checkIntervalId) clearInterval(checkIntervalId);
                if (autoSaveIntervalId) clearInterval(autoSaveIntervalId);
                checkIntervalId = null;
                autoSaveIntervalId = null;
                cachedVideo = null;
            }
        };
    };
    
    // Setup keyboard shortcut handling
    const setupKeyboardShortcuts = () => {
    document.addEventListener('keydown', (e) => {
        try {
                // Check for Escape key to dismiss notifications
                if (e.key === 'Escape') {
                    const notification = notificationContainer;
                    if (notification && document.body.contains(notification) && 
                        notification.style.display !== 'none' && 
                        notification.style.opacity !== '0') {
                        
                        debug('Dismissing notification with Escape key');
                        
                        // Clear any existing timeout
                        if (notificationTimeout) {
                            clearTimeout(notificationTimeout);
                            notificationTimeout = null;
                        }
                        
                        // Hide with quick animation
                        notification.style.transition = 'all 150ms cubic-bezier(0.4, 0, 0.2, 1)';
                        notification.style.opacity = '0';
                        notification.style.transform = 'translateZ(0) translateY(-10px) scale(0.96)';
                        
                        // Clean up after animation
                        setTimeout(() => {
                            notification.style.display = 'none';
                            // Reset progress bar
                            const progressBar = notification.querySelector('.notification-progress');
                            if (progressBar) {
                                progressBar.style.transition = 'none';
                                progressBar.style.width = '100%';
                            }
                        }, 150);
                        
                        // Prevent default only if we actually dismissed a notification
                        e.preventDefault();
                        return;
                    }
                }
                
            // Build the key combination string
            const keyCombo = [];
            if (e.ctrlKey) keyCombo.push('CTRL');
            if (e.altKey) keyCombo.push('ALT');
            if (e.shiftKey) keyCombo.push('SHIFT');
            if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
                keyCombo.push(e.key.toUpperCase());
            }
            const keyString = keyCombo.join('+');

            if (settings.saveHotkey && keyString === settings.saveHotkey) {
                e.preventDefault();
                const video = document.querySelector('video');
                const videoId = getVideoId();
                if (video && videoId) {
                    saveTimestamp(videoId, video.currentTime, true);
                }
            } else if (settings.restoreHotkey && keyString === settings.restoreHotkey) {
                e.preventDefault();
                const video = document.querySelector('video');
                const videoId = getVideoId();
                if (video && videoId) {
                    const savedData = loadTimestamp(videoId);
                    if (savedData) {
                        video.currentTime = savedData.time;
                            showNotification(`Jumped back to ${formatTime(savedData.time)}`, '⏮️')
                                .catch(error => debug(`Error showing restore hotkey notification: ${error.message}`));
                        } else {
                            debug('No saved timestamp found for restore hotkey');
                    }
                }
            } else if (settings.settingsHotkey && keyString === settings.settingsHotkey) {
                e.preventDefault();
                    debug('Opening settings via hotkey');
                const settingsDiv = createSettingsUI();
                settingsDiv.classList.add('show');
            }
        } catch (error) {
                console.error('Error handling keyboard shortcut:', error);
            }
        });
        
        debug('Keyboard shortcuts configured');
    };
    
    // Add observer for YouTube's SPA navigation
    const setupMutationObserver = () => {
        debug('Setting up enhanced MutationObserver for YouTube navigation');

        // Keep track of the last URL to detect navigation
        let lastUrl = window.location.href;
        let navigationTimerId = null;
        let lastVideoId = null;

        // Function to handle URL changes (navigation)
        const handleNavigationChange = () => {
            const currentUrl = window.location.href;
            const videoId = getVideoId();
            
            // Check if we've actually navigated to a new page or video
            if (currentUrl !== lastUrl || (videoId && videoId !== lastVideoId)) {
                debug(`Navigation detected: ${lastUrl} -> ${currentUrl}`);
                debug(`Video ID: ${lastVideoId || 'none'} -> ${videoId || 'none'}`);
                
                // Update tracking variables
                lastUrl = currentUrl;
                lastVideoId = videoId;
                
                // Clear any existing timers to prevent race conditions
                if (navigationTimerId) {
                    clearTimeout(navigationTimerId);
                }
                
                // If we're on a video page
                if (videoId) {
                    debug(`Processing navigation to video: ${videoId}`);
                    
                    // Reset notification state
                    if (notificationContainer && document.body.contains(notificationContainer)) {
                        debug('Resetting notification state during navigation');
                        notificationContainer.classList.remove('show');
                        
                        if (notificationTimeout) {
                            clearTimeout(notificationTimeout);
                            notificationTimeout = null;
                        }
                        
                        if (notificationAnimationFrame) {
                            cancelAnimationFrame(notificationAnimationFrame);
                            notificationAnimationFrame = null;
                        }
                    }
                    
                    // Use a delay to ensure video player is fully initialized
                    navigationTimerId = setTimeout(() => {
                        const video = document.querySelector('video');
                        
                        if (!video) {
                            debug('No video element found after navigation delay');
                            return;
                        }
                        
                        const savedData = loadTimestamp(videoId);
                        
                        if (!savedData || !settings.autoResume) {
                            debug('No saved timestamp or auto-resume disabled');
                            return;
                        }
                        
                        const currentTime = video.currentTime;
                        
                        // Only restore if the current time is near the beginning
                        // and significantly different from the saved time
                        if (currentTime < 5 && Math.abs(currentTime - savedData.time) > 3) {
                            debug(`SPA navigation: Restoring to saved position ${formatTime(savedData.time)}`);
                            
                            // Set the time
                            video.currentTime = savedData.time;
                            
                            // Show notification with a delay to ensure it appears after the seek is complete
                            if (settings.restoreNotifications) {
                                debug('Preparing to show restore notification after navigation');
                                
                                setTimeout(() => {
                                    // Double-check that we're still on the same video
                                    if (getVideoId() === videoId) {
                                        debug(`Showing restore notification for ${formatTime(savedData.time)}`);
                                        showNotification(`Welcome back! Resumed from ${formatTime(savedData.time)}`, '⏮️')
                                            .catch(error => debug(`Navigation notification error: ${error.message}`));
                                    } else {
                                        debug('Navigation changed before notification could be shown');
                                    }
                                }, 1500);
                            }
                        } else {
                            debug(`Not restoring: Current time ${formatTime(currentTime)}, Saved time ${formatTime(savedData.time)}`);
                        }
                    }, 1200); // Increased timeout for reliable player initialization
                }
            }
        };

        // Create observers for different aspects of navigation detection
        
        // 1. Observer for title changes (most reliable indicator of navigation in YouTube)
        const titleObserver = new MutationObserver(() => {
            debug('Title change detected');
            handleNavigationChange();
        });
        
        if (document.querySelector('title')) {
            titleObserver.observe(document.querySelector('title'), {
                subtree: true,
                characterData: true,
                childList: true
            });
        }
        
        // 2. Observer for main content changes
        const contentObserver = new MutationObserver((mutations) => {
            // Only process significant DOM changes that could indicate navigation
            const significantChanges = mutations.some(mutation => 
                mutation.addedNodes.length > 0 && 
                Array.from(mutation.addedNodes).some(node => 
                    node.nodeType === Node.ELEMENT_NODE && 
                    (node.id === 'content' || 
                     node.id === 'primary' || 
                     node.querySelector('#player'))
                )
            );
            
            if (significantChanges) {
                debug('Significant DOM change detected');
                handleNavigationChange();
            }
        });
        
        // Observe main content areas where navigation changes would be visible
        const contentElements = [
            document.getElementById('content'),
            document.getElementById('page-manager'),
            document.getElementById('primary'),
            document.querySelector('ytd-app'),
            document.body
        ].filter(Boolean);
        
        contentElements.forEach(element => {
            contentObserver.observe(element, {
                childList: true,
                subtree: true,
                attributes: false
            });
        });
        
        // 3. Add standard navigation event listeners
        window.addEventListener('popstate', () => {
            debug('Popstate event detected');
            handleNavigationChange();
        });
        
        window.addEventListener('hashchange', () => {
            debug('Hashchange event detected');
            handleNavigationChange();
        });
        
        // 4. Set up interval for URL polling as a fallback
        const urlCheckInterval = setInterval(() => {
            if (window.location.href !== lastUrl) {
                debug('URL change detected in polling interval');
                handleNavigationChange();
            }
        }, 2000);
        
        // Run an initial check
        setTimeout(handleNavigationChange, 1000);
        
        debug('Enhanced YouTube navigation detection setup complete');
        
        return {
            titleObserver,
            contentObserver,
            urlCheckInterval,
            cleanup: () => {
                titleObserver.disconnect();
                contentObserver.disconnect();
                clearInterval(urlCheckInterval);
                if (navigationTimerId) clearTimeout(navigationTimerId);
                window.removeEventListener('popstate', handleNavigationChange);
                window.removeEventListener('hashchange', handleNavigationChange);
            }
        };
    };
    
    // Start the system
    initializeSystem();
})();
