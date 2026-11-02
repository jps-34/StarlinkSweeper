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
// addDrizzleFile() of the frames, and the range rejection of the zeros by WBPP's
// integration of light frames. They are checked first. When one is missing, the
// run stops with a clear message instead of integrating unmasked frames.

( function()
{
   var TESTED_WBPP = [ "3.2.0" ];
   var root = engine.outputDirectory + "/StarlinkSweeper";
   var copyRoot = root + "/copies";
   var written = [];
   var count = 0;
   var logged = "";

   function log( text )
   {
      console.noteln( "StarlinkSweeper: " + text );
      console.flush();
      logged += text + "\n";
   }

   function stopRun( requestInterruption, problems )
   {
      console.criticalln( "<end><cbr>*** StarlinkSweeper: the masking cannot run with this version of WBPP, "
                          + "the run is stopped so that no frame is integrated unmasked:" );
      for ( var i = 0; i < problems.length; ++i )
         console.criticalln( "*** StarlinkSweeper: " + problems[i] );
      console.criticalln( "*** StarlinkSweeper: run WBPP without the pipeline builder, or update StarlinkSweeper." );
      logged += "STOPPED:\n" + problems.join( "\n" ) + "\n";
      if ( typeof requestInterruption == "function" )
         requestInterruption();
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

   var problems = checkWBPP();
   if ( problems.length > 0 )
   {
      // Nothing is queued for the light frames: this single step stops the run.
      engine.operationQueue.addOperationBlock( function( env, requestInterruption )
      {
         stopRun( requestInterruption, problems );
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
         var folder = "group" + ( ++count < 10 ? "0" : "" ) + count;
         var self = this;

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
   for ( var k = 0; k < queue.operations.length; ++k )
      queue.operations[k].operation.__index__ = k;

   if ( inserted == 0 )
   {
      console.warningln( "StarlinkSweeper: no registration in this pipeline, nothing will be masked." );
      return;
   }

   queue.addOperationBlock( function()
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
   } );
} )();
