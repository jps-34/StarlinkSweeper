/*
 * StarlinkSweeper-WBPP.js
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic), under the direction of Jacques Pouyaud.
 * https://github.com/jps-34/StarlinkSweeper
 *
 * WBPP event script (masking option): masks satellite and aircraft trails in
 * the registered light frames, right after registration and before local
 * normalization and integration. Masked pixels are set to 0, which WBPP
 * integration rejects for light frames (range rejection at 0): a frame with a
 * trail is kept, only the pixels of the trail are left out.
 *
 * Use: WBPP > Pipeline > Event Script, select this file in the installed
 * StarlinkSweeper folder. StarlinkSweeperCore.js, StarlinkSweeperMaskCore.js
 * and StarlinkSweeperMaskEngine.js are loaded from the folder of this file.
 * Masks, coverage map and reports go to <WBPP output>/StarlinkSweeper/<group>/,
 * the log to <WBPP output>/StarlinkSweeper/. WBPP takes one event script per
 * run: this one or ClarkeMask's, not both.
 *
 * WBPP reports an exception thrown here as a warning and carries on: every
 * failure is logged with a "StarlinkSweeper:" prefix, and a frame that could
 * not be processed is left untouched.
 */

// Run on its own (Script > Execute Script File), this file only declares the
// hooks below: say what to do with it. Inside WBPP, engine exists and nothing
// is printed.
if ( typeof engine === "undefined" )
{
   console.show();
   console.warningln( "StarlinkSweeper-WBPP.js is a WBPP event script and does nothing on its own. In WBPP, " +
                      "Pipeline tab, 'Event Script' box: tick it, select this file, then run WBPP." );
   console.warningln( "StarlinkSweeper-WBPP.js est un script d'événement de WBPP et ne fait rien seul. Dans WBPP, " +
                      "onglet Pipeline, cadre « Event Script » : le cocher, choisir ce fichier, puis lancer WBPP." );
}

function __starlinkSweeperLog( state, text )
{
   console.noteln( "StarlinkSweeper: " + text );
   console.flush();
   state.starlinkSweeperLog = ( state.starlinkSweeperLog || "" ) + text + "\n";
}

function onPipelineStart( env, state )
{
   state.starlinkSweeperReady = false;
   state.starlinkSweeperGroups = 0;
   try
   {
      var dir = File.extractDrive( engine.pipelineScriptFile ) + File.extractDirectory( engine.pipelineScriptFile );
      // The scan core declares many top-level names: it is evaluated inside a
      // function, and only its StarlinkSweeperScan object becomes global.
      ( 0, eval )( "var StarlinkSweeperScan = ( function() {\n" + File.readTextFile( dir + "/StarlinkSweeperCore.js" ) +
                   "\nreturn StarlinkSweeperScan;\n} )();" );
      // these two define one namespace each (indirect eval: global)
      ( 0, eval )( File.readTextFile( dir + "/StarlinkSweeperMaskCore.js" ) );
      ( 0, eval )( File.readTextFile( dir + "/StarlinkSweeperMaskEngine.js" ) );
      state.starlinkSweeperReady = true;
      __starlinkSweeperLog( state, "StarlinkSweeper " + StarlinkSweeperMaskEngine.VERSION + " masking ready (" + dir + ")" );
   }
   catch ( e )
   {
      __starlinkSweeperLog( state, "** unable to load the StarlinkSweeper files next to the event script: " + e.message );
   }
}

function onOperationDone( env, state )
{
   if ( env.name != "Registration" || !env.group || !state.starlinkSweeperReady )
      return;
   var g = env.group;
   if ( g.imageType != ImageType.Light )
      return;
   if ( env.status == OperationBlockStatus.FAILED )
   {
      __starlinkSweeperLog( state, "registration failed for this group: nothing masked" );
      return;
   }
   try
   {
      var frames = g.activeFrames(), paths = [];
      for ( var i = 0; i < frames.length; ++i )
         paths.push( frames[i].current );
      if ( paths.length == 0 )
         return;
      var n = ++state.starlinkSweeperGroups;
      var out = engine.outputDirectory + "/StarlinkSweeper/group" + ( n < 10 ? "0" : "" ) + n;
      __starlinkSweeperLog( state, "group " + n + ": " + paths.length + " registered frames" );
      var res = StarlinkSweeperMaskEngine.processGroup( paths, {
         outputDir: out,
         log: function( s ) { __starlinkSweeperLog( state, "   " + s ); }
      } );
      if ( res.failed.length > 0 )
         __starlinkSweeperLog( state, "** " + res.failed.length + " frame(s) left untouched in group " + n );
   }
   catch ( e )
   {
      __starlinkSweeperLog( state, "** error, group left as registered: " + e.message );
   }
}

function onPipelineEnd( env, state )
{
   if ( !state.starlinkSweeperLog )
      return;
   try
   {
      var dir = engine.outputDirectory + "/StarlinkSweeper";
      if ( !File.directoryExists( dir ) )
         File.createDirectory( dir, true );
      File.writeTextFile( dir + "/StarlinkSweeper.log", state.starlinkSweeperLog );
   }
   catch ( e )
   {
      console.warningln( "StarlinkSweeper: unable to write the log: " + e.message );
   }
}
