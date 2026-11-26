// Body of the WBPP pipeline builder (source of StarlinkSweeper-PipelineBuilder.js,
// see tools/build_pipeline_builder.py).
//
// Builds WBPP's standard light pipeline and inserts one step after each
// registration. The step reads the registered frames without changing them,
// writes a masked copy of each frame with trails in its own folder, and gives
// the path of the copy to the following steps of the pipeline (local
// normalization, integration), as every WBPP step does with its output. The last
// step of the pipeline removes the copies; the masks and the reports stay.
//
// Besides the documented interface (buildPipelineForLight(), addOperationBlock()),
// the builder relies on parts of WBPP that may change: the operations array of
// engine.operationQueue, the BPPOperationBlock class, processingSucceeded() and
// addDrizzleFile() of the frames, the range rejection of the zeros by WBPP's
// integration of light frames, and the post-calibration groups with their
// integration mode (groupsManager.groupsForMode(), isActive, fastIntegrationData).
// They are checked first. When one is missing, the run stops with a clear message
// instead of integrating unmasked frames.
//
// Fast integration has no registration step, hence no masking step. A light group
// switched to fast integration by WBPP's automatic integration mode stops the run:
// the user may not have noticed it. A group set to fast integration by the user
// (on the group, or WBPP's fast mode) is accepted with a warning: its frames are
// not masked, the other groups are.

( function()
{
   var TESTED_WBPP = [ "3.2.0" ];
   var root = engine.outputDirectory + "/StarlinkSweeper";
   var copyRoot = root + "/copies";
   var written = [];
   var logged = "";
   var INCOMPATIBLE = "the masking cannot run with this version of WBPP";
   var UPDATE = "run WBPP without the pipeline builder, or update StarlinkSweeper.";

   function log( text )
   {
      console.noteln( "StarlinkSweeper: " + text );
      console.flush();
      logged += text + "\n";
   }

   function warn( text )
   {
      console.warningln( "** StarlinkSweeper: " + text );
      console.flush();
      logged += "WARNING: " + text + "\n";
   }

   // Removes the masked copies and writes the log. Runs as the last step of the
   // pipeline, and when the run is stopped, since an interruption cancels that step.
   function finish( reportCount )
   {
      var removed = 0;
      for ( var i = 0; i < written.length; ++i )
         try
         {
            File.remove( written[i] );
            ++removed;
         }
         catch ( e )
         {
            log( "** unable to remove " + written[i] + ": " + e.message );
         }
      written = [];
      if ( reportCount || removed > 0 )
         log( removed + " masked copies removed" );
      try
      {
         if ( !File.directoryExists( root ) )
            File.createDirectory( root, true );
         File.writeTextFile( root + "/StarlinkSweeper.log", logged );
      }
      catch ( e )
      {
         console.warningln( "StarlinkSweeper: unable to write the log: " + e.message );
      }
   }

   function stopRun( requestInterruption, problems, reason, advice )
   {
      reason = reason || INCOMPATIBLE;
      advice = advice || UPDATE;
      console.criticalln( "<end><cbr>*** StarlinkSweeper: " + reason
                          + ", the run is stopped so that no frame is integrated unmasked:" );
      for ( var i = 0; i < problems.length; ++i )
         console.criticalln( "*** StarlinkSweeper: " + problems[i] );
      console.criticalln( "*** StarlinkSweeper: " + advice );
      logged += "STOPPED: " + reason + ":\n" + problems.join( "\n" ) + "\n" + advice + "\n";
      if ( typeof requestInterruption == "function" )
         requestInterruption();
      finish();
   }

   // Queues an operation block in front of the queue, before WBPP's calibration of
   // the bias, dark and flat frames, which is queued before the builder runs. When
   // the operations array is not as expected, the block stays at the end.
   function queueFirst( block )
   {
      engine.operationQueue.addOperationBlock( block );
      var ops = engine.operationQueue.operations;
      if ( !Array.isArray( ops ) || ops.length < 2 )
         return;
      ops.unshift( ops.pop() );
      for ( var k = 0; k < ops.length; ++k )
         ops[k].operation.__index__ = k;
   }

   function describe( group )
   {
      try { return group.toString(); } catch ( e ) { return "filter " + group.filter; }
   }

   // Active post-calibration light groups integrated with fast integration, by origin
   // of the choice: WBPP's automatic integration mode, or the user.
   function fastIntegrationGroups()
   {
      var result = { automatic: [], chosen: [], problems: [] };
      var manager = engine.groupsManager;
      if ( !manager || typeof manager.groupsForMode != "function" || !BPP.GroupingMode
           || BPP.GroupingMode.POST === undefined )
      {
         result.problems.push( "the post-calibration groups cannot be read (groupsManager.groupsForMode(), BPP.GroupingMode.POST)" );
         return result;
      }
      var groups = manager.groupsForMode( BPP.GroupingMode.POST );
      if ( !Array.isArray( groups ) )
      {
         result.problems.push( "the post-calibration groups cannot be read (groupsForMode() returned no list)" );
         return result;
      }
      for ( var i = 0; i < groups.length; ++i )
      {
         var g = groups[i];
         if ( g.imageType != ImageType.Light )
            continue;
         var fi = g.fastIntegrationData;
         if ( typeof g.isActive != "boolean" || !fi || typeof fi.enabled != "boolean"
              || typeof fi.automatic != "boolean" || typeof fi.manuallyChanged != "boolean" )
         {
            result.problems.push( "the integration mode of the light groups cannot be read "
                                  + "(isActive, fastIntegrationData: enabled, automatic, manuallyChanged)" );
            return result;
         }
         if ( g.isActive && fi.enabled )
            ( fi.automatic ? result.automatic : result.chosen ).push( describe( g ) );
      }
      return result;
   }

   function sourceOf( f )
   {
      try { return typeof f == "function" ? f.toString() : ""; } catch ( e ) { return ""; }
   }

   // What the builder relies on, before anything is queued.
   function checkWBPP()
   {
      var problems = [];
      if ( typeof BPPOperationBlock != "function" )
         problems.push( "the BPPOperationBlock class is missing" );
      if ( typeof OperationBlockStatus == "undefined" || OperationBlockStatus.DONE === undefined
           || OperationBlockStatus.FAILED === undefined )
         problems.push( "the operation states are missing" );
      if ( typeof BPP == "undefined" || !BPP.FrameProcessingStep || BPP.FrameProcessingStep.REGISTRATION === undefined )
         problems.push( "the registration processing step is missing" );
      var q = engine.operationQueue;
      if ( !q || !Array.isArray( q.operations ) || typeof q.addOperationBlock != "function" )
         problems.push( "the operation queue is not as expected" );
      if ( !engine.pipelineManager || typeof engine.pipelineManager.buildPipelineForLight != "function" )
         problems.push( "buildPipelineForLight() is missing" );
      var integrate = sourceOf( engine.imageProcessor && engine.imageProcessor.doIntegrate );
      if ( !/II\.rangeClipLow\s*=\s*true/.test( integrate ) || !/II\.rangeLow\s*=\s*0\s*;/.test( integrate ) )
         problems.push( "WBPP's integration no longer shows the range rejection of the zeros (rangeClipLow, rangeLow = 0)" );
      return problems;
   }

   // What the step relies on, on the frames of its group.
   function checkFrames( frames )
   {
      for ( var i = 0; i < frames.length; ++i )
      {
         var f = frames[i];
         if ( typeof f.current != "string" || typeof f.processingSucceeded != "function"
              || typeof f.addDrizzleFile != "function" )
            return [ "the frames of WBPP are not as expected (current, processingSucceeded(), addDrizzleFile())" ];
      }
      return [];
   }

   // Nothing is queued for the light frames when the run must stop: a single step,
   // in front of the queue, stops it before anything is calibrated. Messages are
   // written when the run starts, not here: WBPP runs the builder again at almost
   // every change in its window.
   var problems = checkWBPP();
   var fast = problems.length > 0 ? null : fastIntegrationGroups();
   if ( fast )
      problems = fast.problems;
   if ( problems.length > 0 )
   {
      queueFirst( function( env, requestInterruption )
      {
         stopRun( requestInterruption, problems );
      } );
      return;
   }
   if ( fast.automatic.length > 0 )
   {
      queueFirst( function( env, requestInterruption )
      {
         stopRun( requestInterruption, fast.automatic,
                  "WBPP's automatic integration mode switched these light groups to fast integration, "
                  + "which has no registration step: they would not be masked",
                  "uncheck Automatic integration mode, or set the integration mode of these groups yourself "
                  + "in the post-calibration panel (fast integration set by hand is accepted, its frames are "
                  + "not masked)." );
      } );
      return;
   }

   engine.pipelineManager.buildPipelineForLight();

   var MaskingOperation = class extends BPPOperationBlock
   {
      constructor( registration )
      {
         super( "StarlinkSweeper masking", registration.group, true /* trackable */ );
         var group = registration.group;
         var self = this;
         // Named once all the steps are queued, in the order they run (see below).
         this.folder = "";

         this.envForScript = () => ( { name: "StarlinkSweeper masking", status: this.status, statusMessage: this.statusMessage, group: group } );

         this._run = function( environment, requestInterruption )
         {
            function fail( list )
            {
               stopRun( requestInterruption, list );
               self.statusMessage = "stopped: " + list[0];
               return OperationBlockStatus.FAILED;
            }

            if ( registration.status != OperationBlockStatus.DONE )
            {
               log( "registration did not complete for this group: nothing masked" );
               return OperationBlockStatus.DONE;
            }
            var frames = group.activeFrames(), paths = [];
            var wrong = checkFrames( frames );
            if ( wrong.length > 0 )
               return fail( wrong );
            for ( var i = 0; i < frames.length; ++i )
               paths.push( frames[i].current );
            if ( paths.length == 0 )
               return OperationBlockStatus.DONE;
            var version = BPP.Version && BPP.Version.WBPP_VERSION;
            var folder = self.folder;
            log( "StarlinkSweeper " + StarlinkSweeperMaskEngine.VERSION + ", WBPP " + version + ", " + folder + ": "
                 + paths.length + " registered frames" );
            if ( TESTED_WBPP.indexOf( version ) < 0 )
               log( "** WBPP " + version + " has not been tested with this builder (tested: " + TESTED_WBPP.join( ", " )
                    + "); the parts it relies on were checked" );
            var res = StarlinkSweeperMaskEngine.processGroup( paths, {
               outputDir: root + "/" + folder,
               copyDir: copyRoot + "/" + folder,
               log: function( s ) { log( "   " + s ); }
            } );
            if ( res.failed.length > 0 )
               return fail( [ res.failed.length + " frame(s) of " + folder + " could not be processed, see the log above" ] );
            var byFile = {};
            for ( var r = 0; r < res.results.length; ++r )
               if ( res.results[r].output )
                  byFile[res.results[r].file] = res.results[r].output;
            for ( var f = 0; f < frames.length; ++f )
            {
               var copy = byFile[frames[f].current];
               if ( !copy )
                  continue;
               written.push( copy );
               // WBPP looks for the drizzle data next to the current frame, and
               // integration updates it: the copy gets its own, WBPP's file stays as
               // it is. A previous run may have left one: it is replaced.
               try
               {
                  var drizzle = frames[f].drizzleFile, drizzleCopy = "";
                  if ( drizzle && File.exists( drizzle ) )
                  {
                     drizzleCopy = File.changeExtension( copy, ".xdrz" );
                     if ( File.exists( drizzleCopy ) )
                        File.remove( drizzleCopy );
                     File.copyFile( drizzleCopy, drizzle );
                  }
                  frames[f].processingSucceeded( BPP.FrameProcessingStep.REGISTRATION, copy );
                  if ( drizzleCopy )
                     frames[f].addDrizzleFile( drizzleCopy );
               }
               catch ( e )
               {
                  return fail( [ "unable to hand the masked copy " + copy + " to WBPP: " + e.message ] );
               }
               if ( frames[f].current != copy )
                  return fail( [ "WBPP did not take the masked copy " + copy ] );
            }
            return OperationBlockStatus.DONE;
         };
      }
   };

   // Each masking step goes right after its registration, before local
   // normalization and integration.
   var queue = engine.operationQueue, inserted = 0;
   for ( var i = queue.operations.length - 1; i >= 0; --i )
   {
      var op = queue.operations[i] && queue.operations[i].operation;
      if ( op && op.name == "Registration" && op.group && op.group.imageType == ImageType.Light )
      {
         queue.operations.splice( i + 1, 0, { operation: new MaskingOperation( op ), params: undefined } );
         ++inserted;
      }
   }
   // The steps were inserted from the end of the queue: their folders are named
   // here, in the order they run (group01 is the first group masked).
   var count = 0;
   for ( var k = 0; k < queue.operations.length; ++k )
   {
      var queued = queue.operations[k].operation;
      queued.__index__ = k;
      if ( queued instanceof MaskingOperation )
      {
         ++count;
         queued.folder = "group" + ( count < 10 ? "0" : "" ) + count;
      }
   }

   if ( inserted == 0 )
   {
      console.warningln( "StarlinkSweeper: no registration in this pipeline, nothing will be masked." );
      return;
   }

   if ( fast.chosen.length > 0 )
      queueFirst( function()
      {
         for ( var i = 0; i < fast.chosen.length; ++i )
            warn( "fast integration was set by hand for this group, its frames are not masked: " + fast.chosen[i] );
      } );

   queue.addOperationBlock( function()
   {
      finish( true /* reportCount */ );
   } );
} )();
