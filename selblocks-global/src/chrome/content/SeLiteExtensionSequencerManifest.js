Components.utils.import("chrome://selite-extension-sequencer/content/SeLiteExtensionSequencer.js");
            SeLiteExtensionSequencer.registerPlugin( {
                pluginId: 'selblocks-global@selite.googlecode.com',
                coreUrl: 'chrome://selite-selblocks-global/content/extensions/selblocks-global.js',
                requisitePlugins: { 'testcase-debug-context@selite.googlecode.com': 'SeLite TestCase Debug Context' }
            } );

var EXPORTED_SYMBOLS= [];